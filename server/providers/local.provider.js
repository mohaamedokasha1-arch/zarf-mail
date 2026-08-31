/**
 * =============================================================
 *  المزوّد المحلي (Local) — بدون خدمة خارجية
 * -------------------------------------------------------------
 *  يعتمد على:
 *    - سيرفر SMTP المدمج (server/smtp/server.js)  → إن كان بورت 25 متاحاً
 *    - ويب هوك /api/inbound/webhook               → Cloudflare / Mailgun
 *
 *  مفيد للتجربة المحلية، أو عند التشغيل على VPS مع دومين خاص،
 *  أو حين تريد استقبالاً من خدمتك الخاصة.
 *
 *  ملاحظة: الرسائل تصل إلى قاعدة البيانات مباشرة (دفع)،
 *  لذلك لا يحتاج هذا المزوّد إلى مزامنة دورية (sync = عملية فارغة).
 * =============================================================
 */

const crypto = require('crypto');
const config = require('../config');
const logger = require('../lib/logger');
const {
  randomLocalPart: randomPart,
  validateCustomLocalPart,
  pickDomain,
  secretToken,
  shortId,
} = require('../lib/utils');

const NAME = 'local';

/** 1) الدومينات: من إعدادات السيرفر */
async function listDomains() {
  return config.domains;
}

/** 2) إنشاء صندوق محلي */
async function createMailbox({ custom, domain } = {}) {
  let localPart;
  if (custom) {
    const check = validateCustomLocalPart(custom);
    if (!check.valid) {
      const err = new Error(check.reason);
      err.status = 400;
      throw err;
    }
    localPart = check.value;
  } else {
    localPart = randomPart();
  }

  const selectedDomain = pickDomain(domain);
  const address = `${localPart}@${selectedDomain}`;

  return {
    provider: NAME,
    address,
    localPart,
    domain: selectedDomain,
    providerId: null,
    password: secretToken(18),
    token: secretToken(24),
  };
}

/** 3) لا مزامنة: الرسائل تصل بالدفع (SMTP/Webhook) */
async function listMessages() {
  return [];
}

/** 4) استقبال رسالة خام (يستدعي منطق التخزين المشترك) */
async function ingestRaw(raw) {
  // تحميل كسول لتجنّب التبعية الدائرية (mailbox → providers → mailbox)
  const mailboxService = require('../services/mailbox');
  return mailboxService.ingestRawEmail(raw);
}

/** 5) استقبال رسالة على شكل حقول جاهزة */
async function ingestFields(fields) {
  const mailboxService = require('../services/mailbox');
  return mailboxService.ingestFields(fields);
}

/** 6) عمليات الحذف محلية بالكامل (تُنفَّذ على قاعدة البيانات) */
async function deleteMessage() { return true; }
async function deleteMailbox() { return true; }
async function markSeen() { return true; }
async function refreshToken() { return null; }
async function getMessage() { return null; }

function describe() {
  return {
    name: NAME,
    label: 'محلي (SMTP/Webhook)',
    realDomains: false,
    domains: config.domains,
    smtp: config.smtp.enabled ? config.smtp.port : false,
    note: 'الرسائل تصل بالدفع عبر SMTP أو الويب هوك — بلا مزامنة دورية',
  };
}

module.exports = {
  name: NAME,
  listDomains,
  createMailbox,
  listMessages,
  getMessage,
  markSeen,
  deleteMessage,
  deleteMailbox,
  refreshToken,
  ingestRaw,
  ingestFields,
  describe,
};
