/**
 * =============================================================
 *  مسارات استقبال البريد الوارد (Inbound) — ظرف
 * -------------------------------------------------------------
 *  ثلاث طرق لاستقبال الرسائل، فعّل ما يناسب استضافتك:
 *
 *  1) POST /api/inbound/webhook  ← Cloudflare Email Routing (عن طريق Worker)
 *     يرسل الـ Worker نص الرسالة الخام RFC822 مع هيدر x-zarf-webhook-key
 *
 *  2) POST /api/inbound/mailgun  ← Mailgun Routes (MIME أو حقول form)
 *
 *  3) سيرفر SMTP مدمج (server/smtp/server.js) ← إن كان بورت 25 متاحاً
 *
 *  كل الطرق تنتهي بنفس الدالة: ingestRawEmail / ingestFields
 * =============================================================
 */

const express = require('express');
const config = require('../config');
const logger = require('../lib/logger');
const { ingestRawEmail, ingestFields } = require('../services/mailbox');

const router = express.Router();

/** التحقق من المفتاح السري للويب هوك */
function checkKey(req, res, next) {
  // eslint-disable-next-line global-require
  const providers = require('../providers');
  if (!providers.localEnabled()) {
    return res.status(503).json({ success: false, error: 'الاستقبال المحلي غير مفعّل (MAIL_PROVIDER=mailtm)' });
  }
  if (!config.inboundWebhook.enabled) {
    return res.status(503).json({ success: false, error: 'استقبال الويب هوك معطّل' });
  }
  const provided =
    req.get('x-zarf-webhook-key') ||
    req.get('x-webhook-key') ||
    (req.query && req.query.key);

  if (!provided || provided !== config.inboundWebhook.key) {
    logger.warn('محاولة ويب هوك بمفتاح غير صالح من ' + req.ip);
    return res.status(401).json({ success: false, error: 'مفتاح الويب هوك غير صالح' });
  }
  return next();
}

/* ------------------------------------------------------------------------
 *  1) ويب هوك عام: يقبل RFC822 خام (Cloudflare Worker) أو JSON أو Form
 * ---------------------------------------------------------------------- */
router.post(
  '/webhook',
  checkKey,
  express.raw({ type: ['message/rfc822', 'text/plain', 'application/octet-stream'], limit: '5mb' }),
  express.json({ limit: '5mb' }),
  express.urlencoded({ extended: true, limit: '5mb' }),
  async (req, res) => {
    try {
      let result;

      if (Buffer.isBuffer(req.body) && req.body.length > 0) {
        // الحالة الأولى: الرسالة الخام كما يرسلها Cloudflare Worker
        result = await ingestRawEmail(req.body);
      } else if (req.is('multipart/form-data') || req.body?.['body-plain'] || req.body?.recipient) {
        // الحالة الثانية: حقول Mailgun / SendGrid
        result = ingestFields(req.body);
      } else if (req.body?.raw) {
        result = await ingestRawEmail(req.body.raw);
      } else {
        return res.status(400).json({ success: false, error: 'صيغة الطلب غير مدعومة' });
      }

      if (!result.ok) {
        return res.status(202).json({ success: false, error: result.reason });
      }
      return res.status(202).json({ success: true, messageId: result.messageId, otp: result.otp?.code || null });
    } catch (error) {
      logger.error('خطأ في الويب هوك:', error.message);
      return res.status(500).json({ success: false, error: error.message });
    }
  }
);

/* ------------------------------------------------------------------------
 *  2) مسار مخصّص لـ Mailgun (MIME كامل)
 * ---------------------------------------------------------------------- */
router.post('/mailgun', checkKey, async (req, res) => {
  try {
    const raw = req.body?.['body-mime'] || req.body?.email || req.rawBody;
    const result = raw ? await ingestRawEmail(raw) : ingestFields(req.body || {});
    return res.status(result.ok ? 202 : 400).json({ success: result.ok, error: result.reason });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
