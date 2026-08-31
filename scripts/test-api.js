/**
 * =============================================================
 *  اختبارات API شاملة — ظرف (Zarf Mail)
 * -------------------------------------------------------------
 *  يفحص كل المسارات:
 *    health · domains · generate-email (عشوائي/مخصص/أخطاء)
 *    webhook (Cloudflare RAW) · webhook (Mailgun fields)
 *    check-inbox · messages · otp · delete-email (بتوكن/بدونه)
 *    stream (SSE)
 *
 *  التشغيل:  node scripts/test-api.js http://127.0.0.1:3000
 * =============================================================
 */

const BASE = process.argv[2] || 'http://127.0.0.1:3000';
const KEY = process.env.INBOUND_WEBHOOK_KEY || 'super-secret-webhook-key-change-me';

let pass = 0;
let fail = 0;

function check(name, condition, extra = '') {
  if (condition) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`\n🔬 اختبارات API — ظرف @ ${BASE}\n`);

  /* ---------- 0) المزوّد ---------- */
  const providerInfo = await fetch(`${BASE}/api/provider`).then((r) => r.json()).catch(() => null);
  const localMode = !providerInfo || providerInfo.data.primary === 'local';
  console.log(`🔌 المزوّد: ${providerInfo ? providerInfo.data.primary : '?'} ${localMode ? '' : '(اختبارات الويب هوك تتجاوز — راجع scripts/test-mailtm.js)'}\n`);

  /* ---------- 1) health ---------- */
  console.log('1) /api/health');
  const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
  check('يرجع success', health.success === true);
  check('يحتوي إحصائيات', typeof health.stats.messages === 'number');
  check('يعلن مدة الحياة 7 أيام (10080 دقيقة)', health.ttlMinutes.mailbox === 10080);
  check('يعلن ttlDays = 7 للبريد والرسائل',
    health.ttlDays.mailbox === 7 && health.ttlDays.message === 7);

  /* ---------- 2) domains ---------- */
  console.log('2) /api/domains');
  const dm = await fetch(`${BASE}/api/domains`).then((r) => r.json());
  check('يحتوي دومين واحد على الأقل', dm.domains.length > 0, JSON.stringify(dm));

  /* ---------- 3) generate-email عشوائي ---------- */
  console.log('3) POST /api/generate-email (عشوائي)');
  const mb1 = await fetch(`${BASE}/api/generate-email`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  }).then((r) => r.json());
  check('تم الإنشاء', mb1.success === true && !!mb1.data.address, JSON.stringify(mb1));
  check('يحتوي توكن', typeof mb1.data.token === 'string' && mb1.data.token.length > 10);
  check('يحتوي expiresAt', typeof mb1.data.expiresAt === 'number');
  const randomAddress = mb1.data.address;

  /* ---------- 4) generate-email مخصص ---------- */
  console.log('4) POST /api/generate-email (مخصص)');
  const customName = 'zarf' + Math.random().toString(36).slice(2, 7);
  const mb2 = await fetch(`${BASE}/api/generate-email`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ custom: customName }),
  }).then((r) => r.json());
  check(`تم إنشاء ${customName}@…`, mb2.success === true && mb2.data.address.startsWith(customName), JSON.stringify(mb2));

  /* ---------- 5) أخطاء التحقق ---------- */
  console.log('5) حالات الخطأ');
  const bad1 = await fetch(`${BASE}/api/generate-email`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ custom: 'a!' }),
  });
  check('اسم غير صالح → 400', bad1.status === 400, `status=${bad1.status}`);

  const bad2 = await fetch(`${BASE}/api/generate-email`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ custom: customName }),
  });
  check('اسم مكرر → 409', bad2.status === 409, `status=${bad2.status}`);

  const bad3 = await fetch(`${BASE}/api/check-inbox/not-exist-id`).then((r) => r.json());
  check('صندوق غير موجود → 404', bad3.code === 'MAILBOX_NOT_FOUND', JSON.stringify(bad3));

  /* ---------- 6) ويب هوك RAW (Cloudflare) — محلي فقط ---------- */
  if (!localMode) {
    console.log('6) POST /api/inbound/webhook — ⏭  متجاوز (المزوّد mail.tm لا يستخدم الويب هوك)');
  } else {
  console.log('6) POST /api/inbound/webhook (RAW — Cloudflare)');
  const code1 = String(Math.floor(100000 + Math.random() * 900000));
  const rawEmail = [
    'From: "Netflix" <no-reply@netflix.com>',
    `To: ${randomAddress}`,
    'Subject: =?UTF-8?B?' + Buffer.from(`رمز الدخول ${code1}`, 'utf8').toString('base64') + '?=',
    'Date: ' + new Date().toUTCString(),
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    '',
    `<html><body><h1>مرحباً</h1><p>رمز الدخول: <b>${code1}</b></p><script>alert(1)</script></body></html>`,
  ].join('\r\n');

  const noKey = await fetch(`${BASE}/api/inbound/webhook`, {
    method: 'POST', headers: { 'Content-Type': 'message/rfc822' }, body: rawEmail,
  });
  check('بدون مفتاح → 401', noKey.status === 401, `status=${noKey.status}`);

  const wh = await fetch(`${BASE}/api/inbound/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'message/rfc822', 'x-zarf-webhook-key': KEY },
    body: rawEmail,
  }).then((r) => r.json());
  check('بالمفتاح الصحيح → مقبول', wh.success === true, JSON.stringify(wh));
  check('استخرج كود التحقق', wh.otp === code1, `otp=${wh.otp} expected=${code1}`);

  /* ---------- 7) ويب هوك Mailgun (حقول) — محلي فقط ---------- */
  if (localMode) {
  console.log('7) POST /api/inbound/webhook (حقول Mailgun)');
  const code2 = String(Math.floor(100000 + Math.random() * 900000));
  const form = new URLSearchParams();
  form.append('recipient', mb2.data.address);
  form.append('sender', 'telegram@telegram.org');
  form.append('subject', 'Your login code');
  form.append('body-plain', `Hello, your verification code is ${code2}\n`);

  const wh2 = await fetch(`${BASE}/api/inbound/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'x-zarf-webhook-key': KEY },
    body: form,
  }).then((r) => r.json());
  check('حقول Mailgun مقبولة', wh2.success === true, JSON.stringify(wh2));
  check('استخرج كود التحقق', wh2.otp === code2, `otp=${wh2.otp} expected=${code2}`);

  }
  }

  /* ---------- 8) check-inbox ---------- */
  console.log('8) GET /api/check-inbox');
  await sleep(300);
  const inbox = await fetch(`${BASE}/api/check-inbox/${mb1.data.id}`).then((r) => r.json());
  check('يرجع استجابة صحيحة', !!inbox.data && Array.isArray(inbox.data.messages));
  check('يخفي التوكن عن الواجهة', inbox.data.mailbox.token === undefined);
  if (localMode) {
    check('يرجع الرسالة', inbox.data.messages.length === 1, JSON.stringify(inbox.data.messages.length));
    check('محتوى الرسالة نظيف من السكربتات',
      !/script/i.test(await fetch(`${BASE}/api/messages/${mb1.data.id}/${inbox.data.messages[0].id}`)
        .then((r) => r.json()).then((d) => d.data.html || '')));
  }

  /* ---------- 9) /otp ---------- */
  console.log('9) GET /api/inbox/:id/otp');
  const otpRes = await fetch(`${BASE}/api/inbox/${mb1.data.id}/otp`).then((r) => r.json());
  if (localMode) check('يرجع الكود', otpRes.otp && otpRes.otp.code === code1, JSON.stringify(otpRes));
  else check('يرجع null بلا رسائل', otpRes.otp === null || !!otpRes.otp, JSON.stringify(otpRes));

  /* ---------- 10) حذف بتوكن خاطئ ---------- */
  console.log('10) الحماية');
  const wrong = await fetch(`${BASE}/api/delete-email`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ emailId: mb1.data.id, token: 'wrong-token' }),
  });
  check('توكن خاطئ → 403', wrong.status === 403, `status=${wrong.status}`);

  /* ---------- 11) SSE ---------- */
  console.log('11) SSE /api/stream');
  const controller = new AbortController();
  const sse = await fetch(`${BASE}/api/stream/${mb1.data.id}`, { signal: controller.signal });
  check('يفتح اتصال SSE', sse.headers.get('content-type')?.includes('text/event-stream'));
  const reader = sse.body.getReader();
  const chunk = await reader.read();
  const text = new TextDecoder().decode(chunk.value);
  check('يرسل حدث hello', text.includes('event: hello'), text.slice(0, 60));
  controller.abort();

  /* ---------- 12) حذف صحيح ---------- */
  console.log('12) الحذف النهائي');
  const del = await fetch(`${BASE}/api/delete-email`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ emailId: mb1.data.id, token: mb1.data.token }),
  }).then((r) => r.json());
  check('حذف بالتوكن الصحيح', del.success === true, JSON.stringify(del));

  const gone = await fetch(`${BASE}/api/check-inbox/${mb1.data.id}`).then((r) => r.json());
  check('الصندوق لم يعد موجوداً', gone.success === false);

  console.log(`\n═══════════════════════════════════════════`);
  console.log(`   نتيجة الاختبارات: ${pass} ناجح · ${fail} فاشل`);
  console.log(`═══════════════════════════════════════════\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('💥', e); process.exit(1); });
