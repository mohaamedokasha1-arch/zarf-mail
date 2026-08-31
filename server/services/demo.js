/**
 * =============================================================
 *  مولّد رسائل تجريبية — ظرف (Zarf Mail)
 * -------------------------------------------------------------
 *  مفيد جداً لتجربة الواجهة بدون إعداد دومين أو استقبال حقيقي:
 *  ينشئ رسالة RFC822 حقيقية (موضوع مشفّر UTF-8 + نسخة HTML)
 *  ثم يمررها على نفس مسار الاستقبال الحقيقي،
 *  فتُستخرج أكواد OTP ويتم التنظيف والتخزين كأي رسالة فعلية.
 *
 *  الاستخدام:
 *    POST /api/demo/inject  { "emailId": "xxxx", "kind": "otp" }
 * =============================================================
 */

const crypto = require('crypto');
const db = require('../db');
const logger = require('../lib/logger');
const { ingestRawEmail } = require('./mailbox');

/** ترميز موضوع عربي بصيغة RFC2047 */
function encodeSubject(text) {
  return `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`;
}

/** يولّد كود تحقق عشوائي من 6 أرقام */
function randomCode() {
  return String(crypto.randomInt(100000, 999999));
}

const SENDERS = [
  { name: 'فريق ظرف', address: 'no-reply@zarf.mail' },
  { name: 'Instagram', address: 'security@mail.instagram.com' },
  { name: 'Telegram', address: 'noreply@telegram.org' },
  { name: 'GitHub', address: 'noreply@github.com' },
  { name: 'OpenAI', address: 'support@openai.com' },
];

const TEMPLATES = {
  /** رسالة تحتوي كود تحقق — لاختبار ميزة استخراج OTP */
  otp: (to) => {
    const code = randomCode();
    const sender = SENDERS[crypto.randomInt(1, SENDERS.length)];
    const subject = `كود التحقق الخاص بك هو ${code}`;
    const html = `
      <div style="font-family:system-ui;padding:24px">
        <h2 style="color:#6366f1">مرحباً بك في ظرف 👋</h2>
        <p>استخدم هذا الكود لإتمام تسجيل الدخول:</p>
        <div style="font-size:32px;font-weight:800;letter-spacing:6px;background:#111827;color:#fff;padding:16px;border-radius:12px;text-align:center">${code}</div>
        <p style="color:#6b7280;font-size:13px">ينتهي الكود خلال 10 دقائق. إن لم تطلبه تجاهل هذه الرسالة.</p>
      </div>`;
    const text = `مرحباً!\n\nكود التحقق الخاص بك هو: ${code}\n\nينتهي خلال 10 دقائق.\n`;
    return { sender, subject, html, text };
  },

  /** رسالة ترحيبية */
  welcome: (to) => ({
    sender: SENDERS[0],
    subject: 'أهلاً بك في ظرف — بريدك المؤقت جاهز',
    html: `<div style="font-family:system-ui;padding:24px;line-height:1.8">
        <h2 style="color:#06b6d4">ظرفك جاهز ✉️</h2>
        <p>هذا البريد يعمل لمدة ساعة واحدة فقط، ثم يُحذف تلقائياً مع كل محتوياته.</p>
        <p style="color:#6b7280">استمتع بتجربة سريعة وآمنة.</p>
      </div>`,
    text: 'أهلاً بك في ظرف!\nبريدك يعمل لمدة ساعة واحدة ويُحذف تلقائياً.\n',
  }),

  /** رسالة تسويقية بهيكل HTML أطول */
  newsletter: (to) => ({
    sender: { name: 'Zarf Weekly', address: 'weekly@zarf.mail' },
    subject: 'كل ما تحتاج معرفته هذا الأسبوع',
    html: `<div style="font-family:system-ui;padding:20px;background:#f9fafb">
        <h2 style="color:#8b5cf6">أخبار الأسبوع</h2>
        <ul>
          <li>تحديثات جديدة في خدمة ظرف</li>
          <li>نصائح لحماية خصوصيتك على الإنترنت</li>
          <li>ميزات قادمة قريباً</li>
        </ul>
        <a href="https://example.com">اقرأ المزيد</a>
      </div>`,
    text: 'أخبار الأسبوع:\n- تحديثات جديدة\n- نصائح خصوصية\n- ميزات قادمة\n',
  }),
};

/** يبني رسالة RFC822 كاملة من قالب */
function buildRawEmail({ to, sender, subject, html, text }) {
  const boundary = `----=_Part_${crypto.randomBytes(8).toString('hex')}`;
  const messageId = `<${crypto.randomBytes(12).toString('hex')}@zarf.mail>`;
  const date = new Date().toUTCString();

  return [
    `From: ${sender.name} <${sender.address}>`,
    `To: ${to}`,
    `Subject: ${encodeSubject(subject)}`,
    `Date: ${date}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(text, 'utf8').toString('base64'),
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(html, 'utf8').toString('base64'),
    '',
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

/**
 * يحقن رسالة تجريبية في صندوق محدد (أو آخر صندوق تم إنشاؤه)
 * @param {{emailId?: string, kind?: string}} options
 */
async function injectDemoMessage({ emailId, kind = 'otp' } = {}) {
  let mailbox = emailId ? db.getMailboxById(emailId) : null;

  if (!mailbox) {
    // آخر صندوق تم إنشاؤه
    mailbox = db.raw.prepare('SELECT * FROM mailboxes ORDER BY created_at DESC LIMIT 1').get();
  }
  if (!mailbox) {
    return { success: false, error: 'لا يوجد صندوق بريد — أنشئ بريداً أولاً' };
  }

  const template = TEMPLATES[kind] || TEMPLATES.otp;
  const content = template(mailbox.address);
  const raw = buildRawEmail({ to: mailbox.address, ...content });

  const result = await ingestRawEmail(raw);
  if (!result.ok) return { success: false, error: result.reason };

  logger.info(`🧪 رسالة تجريبية (${kind}) أُضيفت إلى ${mailbox.address}`);
  return {
    success: true,
    messageId: result.messageId,
    to: mailbox.address,
    otp: result.otp?.code || null,
  };
}

/* =============================================================
   إرسال رسالة حقيقية عبر SMTP مباشر إلى سيرفر الدومين (MX)
   -------------------------------------------------------------
   يُستخدم مع مزوّد mail.tm: نرسل بريداً فعلياً إلى العنوان
   فيصل إلى صندوق الوارد خلال ثوانٍ (كأن موقعاً خارجياً أرسله).
   ملاحظة: يحتاج خروجاً على البورت 25 — إن كان محجوباً نُبلغ المستخدم بوضوح.
   ============================================================= */
const dns = require('dns').promises;
const nodemailer = require('nodemailer');

/** يبحث عن سيرفر البريد (MX) للدومين */
async function resolveMxHost(domain) {
  const records = await dns.resolveMx(domain);
  if (!records || !records.length) throw new Error(`لا يوجد سجل MX للدومين ${domain}`);
  records.sort((a, b) => a.priority - b.priority);
  return records[0].exchange;
}

/**
 * يرسل بريداً حقيقياً إلى العنوان المحدد
 * @param {string} address
 * @param {'otp'|'welcome'|'newsletter'} kind
 */
async function sendRealEmail(address, kind = 'otp') {
  const domain = String(address).split('@')[1];
  if (!domain) throw new Error('عنوان غير صالح');

  const host = await resolveMxHost(domain);
  const template = TEMPLATES[kind] || TEMPLATES.otp;
  const content = template(address);

  const transport = nodemailer.createTransport({
    host,
    port: 25,
    secure: false,
    tls: { rejectUnauthorized: false },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000,
    name: 'zarf.local',
  });

  const info = await transport.sendMail({
    from: `${content.sender.name} <${content.sender.address}>`,
    to: address,
    subject: content.subject,
    text: content.text,
    html: content.html,
  });

  // نستخرج الكود من المحتوى لنعرضه في الاستجابة (للتأكيد فقط)
  const codeMatch = String(content.subject).match(/(\d{4,8})/) || String(content.text).match(/(\d{4,8})/);

  logger.info(`✉️  رسالة حقيقية أُرسلت إلى ${address} عبر ${host}`);
  return {
    transport: host,
    messageId: info.messageId,
    code: codeMatch ? codeMatch[1] : null,
  };
}

module.exports = { injectDemoMessage, sendRealEmail, buildRawEmail, resolveMxHost, TEMPLATES };
