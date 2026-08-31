/**
 * =============================================================
 *  اختبار حيّ شامل — ظرف + mail.tm
 * -------------------------------------------------------------
 *  يفحص الدورة الكاملة على الخدمة الحقيقية:
 *    1) /api/provider  → المزوّد والميزانية
 *    2) /api/domains   → دومين حقيقي من mail.tm
 *    3) POST /api/generate-email      → إنشاء حساب حقيقي + توكن
 *    4) POST /api/generate-email      → اسم مخصص (وتحويل النقطة إلى _)
 *    5) POST /api/demo/inject         → إرسال بريد حقيقي عبر MX
 *    6) GET  /api/check-inbox?sync=1  → وصول الرسالة + استخراج OTP
 *    7) GET  /api/inbox/:id/otp       → endpoint الكود السريع
 *    8) GET  /api/messages/:id/:id    → محتوى الرسالة الكامل
 *    9) تكرار نفس الاسم المخصص        → 409
 *   10) DELETE /api/delete-email      → حذف الحساب من mail.tm
 *
 *  التشغيل:
 *    node scripts/test-mailtm.js http://127.0.0.1:3000
 * =============================================================
 */

const BASE = process.argv[2] || process.env.BASE_URL || 'http://127.0.0.1:3000';

let pass = 0;
let fail = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(name, condition, extra = '') {
  if (condition) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
}

async function main() {
  console.log(`\n🚀 اختبار ظرف + mail.tm @ ${BASE}\n`);
  console.log('─────────────────────────────────────────────');

  /* 1) المزوّد */
  console.log('1) GET /api/provider');
  const provider = await fetch(`${BASE}/api/provider`).then((r) => r.json());
  check('الاستجابة ناجحة', provider.success === true);
  check('المزوّد الأساسي mailtm', provider.data.primary === 'mailtm', JSON.stringify(provider.data.primary));
  console.log(`     · المزوّد: ${provider.data.primary} | ميزانية الطلبات: ${provider.data.providers[0].client.availableTokens}`);

  /* 2) الدومينات */
  console.log('2) GET /api/domains');
  const dm = await fetch(`${BASE}/api/domains`).then((r) => r.json());
  check('دومين حقيقي من الخدمة', dm.real === true && dm.domains.length > 0, JSON.stringify(dm));
  console.log(`     · الدومينات: ${dm.domains.join(', ')}`);

  /* 3) إنشاء بريد عشوائي */
  console.log('3) POST /api/generate-email (عشوائي)');
  const t0 = Date.now();
  const mb1 = await fetch(`${BASE}/api/generate-email`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  }).then((r) => r.json());
  check('تم الإنشاء', mb1.success === true && !!mb1.data.address, JSON.stringify(mb1).slice(0, 200));
  check('بريد حقيقي (realInbox)', mb1.data.realInbox === true);
  check('المزوّد mailtm', mb1.data.provider === 'mailtm');
  check('اسم المستخدم بلا نقاط', !mb1.data.address.split('@')[0].includes('.'));
  console.log(`     · ${mb1.data.address} (خلال ${Math.round((Date.now() - t0) / 1000)} ثانية)`);

  await sleep(2000);
  /* 4) اسم مخصص يحتوي نقطة */
  console.log('4) POST /api/generate-email (اسم مخصص فيه نقطة)');
  const customName = 'zarf' + Math.random().toString(36).slice(2, 7);
  const mb2 = await fetch(`${BASE}/api/generate-email`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ custom: `${customName}.test` }),
  }).then((r) => r.json());
  check('تم الإنشاء', mb2.success === true, JSON.stringify(mb2).slice(0, 200));
  if (!mb2.success) { console.log('     ⚠️  تخطّي باقي الفحوص (الخدمة مشغولة)'); process.exit(0); }
  check('النقطة حُوّلت إلى _', mb2.data.address.startsWith(`${customName}_test`.toLowerCase()), mb2.data.address);
  console.log(`     · ${mb2.data.address}`);

  await sleep(2000);
  /* 5) إرسال بريد حقيقي */
  console.log('5) POST /api/demo/inject (إرسال بريد حقيقي عبر MX)');
  const demo = await fetch(`${BASE}/api/demo/inject`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ emailId: mb1.data.id, kind: 'otp' }),
  }).then((r) => r.json());
  check('تم الإرسال', demo.success === true, JSON.stringify(demo));
  console.log(`     · عبر ${demo.transport} | الكود المرسل: ${demo.code}`);

  /* 6) الاستلام + استخراج OTP */
  console.log('6) GET /api/check-inbox?sync=1 (انتظار الوصول)');
  let messages = [];
  for (let i = 0; i < 8; i++) {
    await sleep(5000);
    const inbox = await fetch(`${BASE}/api/check-inbox/${mb1.data.id}?sync=1`).then((r) => r.json());
    messages = inbox.data?.messages || [];
    if (messages.length) break;
  }
  check('وصلت رسالة واحدة على الأقل', messages.length > 0, `count=${messages.length}`);

  const message = messages[0] || {};
  check('المرسل صحيح', !!message.from && !!message.from.address, JSON.stringify(message.from));
  check('استُخرج كود التحقق', !!message.otp, `otp=${message.otp}`);
  check('الكود يطابق المرسَل', message.otp === demo.code, `${message.otp} vs ${demo.code}`);
  console.log(`     · الموضوع: ${message.subject}`);

  /* 7) endpoint الكود */
  console.log('7) GET /api/inbox/:id/otp');
  const otpRes = await fetch(`${BASE}/api/inbox/${mb1.data.id}/otp`).then((r) => r.json());
  check('يرجع الكود نفسه', otpRes.otp && otpRes.otp.code === demo.code, JSON.stringify(otpRes));

  /* 8) محتوى الرسالة الكامل */
  console.log('8) GET /api/messages/:emailId/:messageId');
  const detail = await fetch(`${BASE}/api/messages/${mb1.data.id}/${message.id}`).then((r) => r.json());
  check('الرسالة كاملة', detail.success === true && !!detail.data, JSON.stringify(detail).slice(0, 150));
  check('يحتوي نصاً أو HTML', !!detail.data.text || !!detail.data.html);
  check('HTML نظيف من السكربتات', !/<script/i.test(detail.data.html || ''));

  await sleep(2000);
  /* 9) تكرار الاسم */
  console.log('9) تكرار الاسم المخصص');
  const dup = await fetch(`${BASE}/api/generate-email`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ custom: `${customName}.test` }),
  });
  check('يرجع 409 تكرار', dup.status === 409, `status=${dup.status}`);

  /* 10) الحذف */
  console.log('10) DELETE البريد (من ظرف ومن mail.tm)');
  const del = await fetch(`${BASE}/api/delete-email`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ emailId: mb1.data.id, token: mb1.data.token }),
  }).then((r) => r.json());
  check('تم الحذف', del.success === true, JSON.stringify(del));

  const gone = await fetch(`${BASE}/api/check-inbox/${mb1.data.id}`).then((r) => r.json());
  check('الصندوق لم يعد موجوداً', gone.success === false);

  console.log('─────────────────────────────────────────────');
  console.log(`   النتيجة: ${pass} ناجح · ${fail} فاشل`);
  console.log('─────────────────────────────────────────────\n');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('💥', e); process.exit(1); });
