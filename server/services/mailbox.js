/**
 * =============================================================
 *  خدمة صناديق البريد — ظرف (Zarf Mail)
 * -------------------------------------------------------------
 *  تحتوي كل منطق العمل:
 *    - إنشاء بريد مؤقت (عشوائي أو بمسمى مخصص)
 *    - استقبال رسالة واردة (خام RFC822 أو حقول جاهزة) وتخزينها
 *    - تجهيز البيانات للإرسال إلى الواجهة (JSON آمن ومخفف)
 * =============================================================
 */

const { simpleParser } = require('mailparser');
const crypto = require('crypto');
const db = require('../db');
const config = require('../config');
const logger = require('../lib/logger');
const providers = require('../providers');
const { extractOtp } = require('../lib/otp');
const { sanitizeMessageHtml } = require('../lib/sanitize');
const {
  shortId,
  secretToken,
  randomLocalPart,
  validateCustomLocalPart,
  pickDomain,
  normalizeAddress,
  splitAddress,
  makeSnippet,
  safeEqual,
  breakdownRemaining,
  safeIso,
  minutesToDays,
} = require('../lib/utils');

const MINUTE = 60 * 1000;

/** نص مقروء لمدة الصلاحية: "7 أيام" أو "60 دقيقة" */
function ttlLabel(minutes) {
  const days = minutesToDays(minutes);
  if (days >= 1) return `${days} ${days === 1 ? 'يوم' : 'أيام'}`;
  return `${minutes} دقيقة`;
}

/* =============================== إنشاء صندوق بريد =============================== */

/**
 * ينشئ بريداً مؤقتاً جديداً عبر المزوّد الأساسي (mail.tm افتراضياً)
 * @param {{custom?: string, domain?: string}} options
 */
async function createMailbox({ custom, domain } = {}) {
  const provider = providers.primary();

  // إنشاء الحساب لدى المزوّد (على mail.tm: /accounts ثم /token)
  const created = await provider.createMailbox({ custom, domain });

  // هل العنوان مستخدم محلياً بالفعل؟ (حماية إضافية)
  if (db.getMailboxByAddress(created.address)) {
    const err = new Error('هذا العنوان مستخدم حالياً، جرّب اسماً آخر');
    err.status = 409;
    throw err;
  }

  const now = Date.now();
  const mailbox = db.createMailbox({
    id: shortId(12),
    address: created.address,
    localPart: created.localPart,
    domain: created.domain,
    token: created.token || secretToken(24),
    createdAt: now,
    expiresAt: now + config.mailboxTtlMinutes * MINUTE,
    provider: created.provider || provider.name,
    providerId: created.providerId || null,
    password: created.password || null,
    lastSyncedAt: null,
  });

  logger.success(`بريد جديد (${mailbox.provider}): ${mailbox.address} (صالح ${ttlLabel(config.mailboxTtlMinutes)})`);
  return mailbox;
}

/**
 * يجلب صندوق بريد عبر المُعرّف (emailId) أو عبر العنوان الكامل
 * ويحدّث وقت آخر استخدام
 */
function resolveMailbox(emailIdOrAddress) {
  if (!emailIdOrAddress) return null;
  const value = normalizeAddress(emailIdOrAddress);
  const mailbox = value.includes('@')
    ? db.getMailboxByAddress(value)
    : db.getMailboxById(value);

  if (mailbox) db.touchMailbox(mailbox.id);
  return mailbox || null;
}

/* =============================== استقبال الرسائل =============================== */

/** يستخرج أول عنوان بريد من حقل قد يكون نصاً أو مصفوفة كائنات */
function firstAddress(field) {
  if (!field) return { name: '', address: '' };
  if (Array.isArray(field)) {
    if (!field.length) return { name: '', address: '' };
    const item = field[0];
    if (typeof item === 'string') return { name: '', address: normalizeAddress(item) };
    return { name: item.name || '', address: normalizeAddress(item.address || '') };
  }
  if (typeof field === 'string') return { name: '', address: normalizeAddress(field) };
  if (field.value && field.value.length) {
    return { name: field.value[0].name || '', address: normalizeAddress(field.value[0].address || '') };
  }
  return { name: field.name || '', address: normalizeAddress(field.address || '') };
}

/** يبحث عن مستلم يطابق دوميناتنا داخل كل حقول المستلمين المحتملة */
function findRecipient(parsed) {
  const pool = [];
  const push = (v) => {
    if (!v) return;
    if (Array.isArray(v)) v.forEach((x) => pool.push(x));
    else pool.push(v);
  };
  push(parsed.to);
  push(parsed.cc);
  push(parsed.bcc);
  push(parsed.envelopeTo);
  if (parsed.headers) {
    push(parsed.headers.get('delivered-to'));
    push(parsed.headers.get('x-original-to'));
    push(parsed.headers.get('envelope-to'));
  }

  for (const item of pool) {
    let address = '';
    if (typeof item === 'string') address = normalizeAddress(item);
    else if (item && item.value && item.value.length) address = normalizeAddress(item.value[0].address);
    else if (item && item.address) address = normalizeAddress(item.address);
    else if (item && item.text) {
      const m = String(item.text).match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
      address = m ? normalizeAddress(m[0]) : '';
    }
    if (!address) continue;
    const parts = splitAddress(address);
    if (parts && config.domains.includes(parts.domain)) return address;
  }
  return null;
}

/**
 * يخزّن رسالة واردة بعد تحويلها إلى شكل موحّد
 * @param {{to: string, from?: object|string, subject?: string, text?: string, html?: string, messageId?: string, attachments?: Array, headers?: object, date?: Date|number}} input
 * @returns {{ok: boolean, reason?: string, message?: object}}
 */
function storeMessage(input) {
  const to = normalizeAddress(input.to);
  if (!to) return { ok: false, reason: 'لا يوجد مستلم' };

  let mailbox = db.getMailboxByAddress(to);

  // إن لم يكن الصندوق موجوداً: أنشئه تلقائياً إن كان الاستقبال المرن مفعّلاً
  if (!mailbox) {
    if (!config.smtp.acceptAny) {
      logger.warn(`رسالة مرفوضة لعنوان غير معروف: ${to}`);
      return { ok: false, reason: 'العنوان غير موجود' };
    }
    const parts = splitAddress(to);
    if (!parts) return { ok: false, reason: 'عنوان غير صالح' };
    const now = Date.now();
    mailbox = db.createMailbox({
      id: shortId(12),
      address: to,
      localPart: parts.localPart,
      domain: parts.domain,
      token: secretToken(24),
      createdAt: now,
      expiresAt: now + config.mailboxTtlMinutes * MINUTE,
      provider: 'local',
      providerId: null,
      password: null,
      lastSyncedAt: null,
    });
    logger.info(`تم إنشاء صندوق تلقائي للرسالة الواردة: ${to}`);
  }

  const sender = firstAddress(input.from);
  const subject = String(input.subject || '(بدون موضوع)').slice(0, 500);

  // تنظيف HTML وتجهيز النص
  const safeHtml = sanitizeMessageHtml(input.html || '');
  const textBody = String(input.text || '').slice(0, 200000);

  // استخراج كود التحقق (OTP) — ميزة ظرف المميزة
  const otp = extractOtp({ subject, text: textBody, html: input.html || '' });

  const now = Date.now();
  const messageId = shortId(14);

  db.insertMessage({
    id: messageId,
    mailboxId: mailbox.id,
    messageId: input.messageId ? String(input.messageId).slice(0, 300) : null,
    fromName: (sender.name || '').slice(0, 150),
    fromAddress: (sender.address || 'unknown').slice(0, 200),
    toAddress: to,
    subject,
    textBody,
    htmlBody: safeHtml,
    snippet: makeSnippet(textBody || require('../lib/otp').htmlToText(safeHtml), 180),
    otpCode: otp ? otp.code : null,
    otpContext: otp ? (otp.context || '').slice(0, 300) : null,
    receivedAt: now,
    expiresAt: now + config.messageTtlMinutes * MINUTE,
    size: Buffer.byteLength((input.text || '') + (input.html || ''), 'utf8'),
    rawHeaders: input.headers ? JSON.stringify(limitHeaders(input.headers)).slice(0, 8000) : null,
    provider: 'local',
    providerId: input.remoteId || null,
    attachments: (input.attachments || []).slice(0, 20).map((a) => ({
      filename: a.filename,
      contentType: a.contentType,
      size: a.size || (a.content ? a.content.length : 0),
    })),
  });

  logger.mail(`📨 ${to} ← ${sender.address} | ${subject.slice(0, 60)}${otp ? ` | OTP: ${otp.code}` : ''}`);

  return { ok: true, mailbox, messageId, otp };
}

/** يحدّ عدد الهيدرات المحفوظة لتوفير المساحة */
function limitHeaders(headers) {
  if (!headers) return {};
  const out = {};
  if (typeof headers.get === 'function') {
    headers.forEach((value, key) => {
      out[String(key).toLowerCase()] = String(value).slice(0, 500);
    });
  } else {
    Object.entries(headers).forEach(([k, v]) => {
      out[String(k).toLowerCase()] = String(v).slice(0, 500);
    });
  }
  return out;
}

/**
 * يستقبل رسالة بصيغتها الخام (RFC822) — من SMTP أو من الـ Webhook
 * @param {Buffer|string} raw
 */
async function ingestRawEmail(raw) {
  const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8');

  if (buffer.length > config.maxMessageSize) {
    logger.warn(`رسالة مرفوضة لتجاوزها الحد الأقصى: ${buffer.length} بايت`);
    return { ok: false, reason: 'حجم الرسالة يتجاوز الحد المسموح' };
  }

  const parsed = await simpleParser(buffer, {
    // لا نحتاج محتوى المرفقات الثنائي — هذا يوفّر الذاكرة ويحمي الخصوصية
    skipAttachmentsData: true,
  });

  const to = findRecipient(parsed);
  if (!to) return { ok: false, reason: 'لا يوجد مستلم يطابق دومينات ظرف' };

  return storeMessage({
    to,
    from: parsed.from,
    subject: parsed.subject,
    text: parsed.text,
    html: parsed.html || '',
    messageId: parsed.messageId,
    attachments: parsed.attachments,
    headers: parsed.headers,
  });
}

/**
 * يستقبل رسالة على شكل حقول جاهزة (Mailgun / SendGrid / JSON مباشر)
 */
function ingestFields(fields) {
  return storeMessage({
    to: fields.to || fields.recipient,
    from: fields.from || fields.sender,
    subject: fields.subject,
    text: fields.text || fields['body-plain'] || fields.textBody || '',
    html: fields.html || fields['body-html'] || fields.htmlBody || '',
    messageId: fields['message-id'] || fields.messageId,
    attachments: [],
    headers: fields.headers,
  });
}

/* =============================== تجهيز البيانات للواجهة =============================== */

/** يحوّل صف رسالة من قاعدة البيانات إلى JSON مرسل للمتصفح */
function serializeMessage(row, { withBody = false } = {}) {
  const base = {
    id: row.id,
    from: {
      name: row.from_name || row.from_address.split('@')[0],
      address: row.from_address,
    },
    subject: row.subject,
    snippet: row.snippet,
    otp: row.otp_code || null,
    receivedAt: row.received_at,
    receivedAtISO: safeIso(row.received_at),
    expiresAt: row.expires_at ?? null,
    expiresAtISO: safeIso(row.expires_at),
    remainingMs: Number.isFinite(Number(row.expires_at))
      ? Math.max(0, Number(row.expires_at) - Date.now())
      : Math.max(0, config.messageTtlMinutes * 60000),
    isRead: !!row.is_read,
    size: row.size,
    hasHtml: !!row.html_body,
    attachments: Array.isArray(row.attachments)
      ? row.attachments.map((a) => ({ filename: a.filename, contentType: a.content_type, size: a.size }))
      : [],
  };

  if (withBody) {
    base.text = row.text_body || '';
    base.html = row.html_body || '';
    base.otpContext = row.otp_context || null;
    base.to = row.to_address;
  }
  return base;
}

/** يحوّل صف صندوق البريد إلى JSON (بدون التوكن ولا كلمة المرور!) */
function serializeMailbox(mailbox, { withToken = false } = {}) {
  const remainingMs = Math.max(0, mailbox.expires_at - Date.now());
  const data = {
    id: mailbox.id,
    emailId: mailbox.id,
    address: mailbox.address,
    domain: mailbox.domain,
    provider: mailbox.provider || 'local',
    realInbox: (mailbox.provider || 'local') !== 'local', // هل يستقبل من الإنترنت فعلاً؟
    createdAt: mailbox.created_at,
    expiresAt: mailbox.expires_at,
    expiresAtISO: safeIso(mailbox.expires_at),
    ttlMinutes: config.mailboxTtlMinutes,
    ttlDays: minutesToDays(config.mailboxTtlMinutes),
    remainingMs,
    remaining: breakdownRemaining(remainingMs), // { days, hours, minutes, seconds }
    remainingLabel: formatRemainingLabel(remainingMs),
    messageCount: mailbox.message_count,
    lastSyncedAt: mailbox.last_synced_at || null,
  };
  if (withToken) data.token = mailbox.token;
  return data;
}

/** نص مقروء للوقت المتبقي: "6 أيام و 23:59" أو "12:34" */
function formatRemainingLabel(ms) {
  const b = breakdownRemaining(ms);
  if (b.expired) return 'منتهي';
  const hhmm = `${String(b.hours).padStart(2, '0')}:${String(b.minutes).padStart(2, '0')}`;
  return b.days > 0 ? `${b.days} يوم و ${hhmm}` : hhmm;
}

/** يتحقق أن التوكن المرسل يطابق توكن الصندوق */
function verifyToken(mailbox, token) {
  return !!token && safeEqual(String(token), String(mailbox.token));
}

module.exports = {
  createMailbox,
  resolveMailbox,
  storeMessage,
  ingestRawEmail,
  ingestFields,
  serializeMessage,
  serializeMailbox,
  verifyToken,
  findRecipient,
};
