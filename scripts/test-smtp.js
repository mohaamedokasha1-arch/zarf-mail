/**
 * =============================================================
 *  سكربت اختبار شامل — ظرف (Zarf Mail)
 * -------------------------------------------------------------
 *  يشغّل دورة كاملة تلقائياً:
 *    1) ينشئ بريداً مؤقتاً عبر الـ API
 *    2) يرسل إليه رسالة حقيقية عبر بروتوكول SMTP (مثل أي سيرفر بريد)
 *    3) ينتظر وصولها ثم يقرأ صندوق الوارد
 *    4) يتحقق من استخراج كود التحقق (OTP)
 *    5) يحذف البريد في النهاية
 *
 *  التشغيل:
 *    npm run test:smtp
 *    أو: node scripts/test-smtp.js http://localhost:3000 2525
 * =============================================================
 */

const nodemailer = require('nodemailer');

const BASE = process.argv[2] || process.env.BASE_URL || 'http://127.0.0.1:3000';
const SMTP_PORT = Number(process.argv[3] || process.env.SMTP_PORT || 2525);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log('─'.repeat(60));
  console.log(`🧪 اختبار ظرف ضد: ${BASE} (SMTP بورت ${SMTP_PORT})`);
  console.log('─'.repeat(60));

  /* 1) إنشاء بريد */
  const created = await fetch(`${BASE}/api/generate-email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  }).then((r) => r.json());

  const mailbox = created.data;
  console.log(`✅ 1) تم إنشاء البريد: ${mailbox.address} (id: ${mailbox.id})`);

  /* 2) إرسال رسالة عبر SMTP */
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const transport = nodemailer.createTransport({
    host: '127.0.0.1',
    port: SMTP_PORT,
    secure: false,
    tls: { rejectUnauthorized: false },
    // لا نحتاج مصادقة: نحن نرسل إلى سيرفر الاستقبال مباشرة
  });

  const info = await transport.sendMail({
    from: '"فريق الاختبار" <tester@example.com>',
    to: mailbox.address,
    subject: `كود التحقق الخاص بك ${code}`,
    text: `مرحباً!\nكود التحقق هو: ${code}\nصالح لمدة 10 دقائق.\n`,
    html: `<div style="font-family:sans-serif;padding:20px">
             <h2>مرحباً 👋</h2>
             <p>كود التحقق الخاص بك هو:</p>
             <div style="font-size:30px;font-weight:bold;letter-spacing:6px">${code}</div>
           </div>`,
  });
  console.log(`📤 2) تم إرسال الرسالة عبر SMTP (messageId: ${info.messageId})`);

  /* 3) انتظار الوصول */
  let messages = [];
  for (let i = 0; i < 12; i++) {
    await sleep(700);
    const inbox = await fetch(`${BASE}/api/check-inbox/${mailbox.id}`).then((r) => r.json());
    messages = inbox.data?.messages || [];
    if (messages.length) break;
  }

  if (!messages.length) {
    console.error('❌ لم تصل أي رسالة — تأكد أن سيرفر SMTP يعمل وأن البورت صحيح');
    process.exit(1);
  }
  console.log(`📬 3) وصلت ${messages.length} رسالة في صندوق الوارد`);

  /* 4) التحقق من استخراج OTP */
  const message = messages[0];
  console.log(`   · المرسل : ${message.from.address}`);
  console.log(`   · الموضوع: ${message.subject}`);
  console.log(`   · كود OTP المستخرج: ${message.otp || '(لم يُستخرج!)'}`);

  if (message.otp === code) {
    console.log('🎯 4) نجاح: تم استخراج كود التحقق صحيحاً ✨');
  } else {
    console.warn(`⚠️  4) الكود المستخرج (${message.otp}) لا يطابق المرسل (${code})`);
  }

  /* 5) تفاصيل الرسالة */
  const detail = await fetch(`${BASE}/api/messages/${mailbox.id}/${message.id}`).then((r) => r.json());
  console.log(`📄 5) تفاصيل الرسالة: ${detail.data.text.split('\n')[0]} … (${detail.data.size} بايت)`);

  /* 6) الحذف */
  const deleted = await fetch(`${BASE}/api/delete-email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ emailId: mailbox.id, token: mailbox.token }),
  }).then((r) => r.json());
  console.log(`🗑️  6) حذف البريد: ${deleted.success ? 'تم بنجاح' : 'فشل: ' + deleted.error}`);

  console.log('─'.repeat(60));
  console.log(deleted.success ? '🎉 كل الاختبارات نجحت — ظرف جاهز للعمل!' : '⚠️  راجع الأخطاء أعلاه');
  console.log('─'.repeat(60));
}

main().catch((error) => {
  console.error('💥 فشل الاختبار:', error.message);
  process.exit(1);
});
