/**
 * =============================================================
 *  واجهات الـ REST API — ظرف (Zarf Mail)
 * -------------------------------------------------------------
 *  Endpoints:
 *    GET    /api/health                     → حالة السيرفر + حالة مزوّد البريد
 *    GET    /api/provider                   → معلومات المزوّد (mail.tm) وميزانية الطلبات
 *    GET    /api/domains                    → الدومينات المتاحة (من المزوّد)
 *    POST   /api/generate-email             → إنشاء بريد جديد (عشوائي أو مخصص)
 *    GET    /api/check-inbox/:emailId       → صندوق الوارد (?sync=1 لمزامنة فورية)
 *    GET    /api/inbox/:emailId/otp         → آخر كود تحقق (OTP) مستلم
 *    GET    /api/messages/:emailId/:id      → تفاصيل رسالة كاملة
 *    POST   /api/messages/:emailId/:id/read → تعليم كمقروءة
 *    DELETE /api/messages/:emailId/:id      → حذف رسالة
 *    POST   /api/delete-email               → حذف البريد (يحتاج التوكن)
 *    DELETE /api/delete-email/:emailId      → نفس السابق بصيغة DELETE
 *    GET    /api/stream/:emailId            → تحديثات فورية SSE
 *    POST   /api/demo/inject                → رسالة تجريبية (يرسل بريداً حقيقياً إن أمكن)
 * =============================================================
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const { minutesToDays, breakdownRemaining } = require('../lib/utils');
const db = require('../db');
const logger = require('../lib/logger');
const services = require('../services/mailbox');
const providerManager = require('../providers');
const syncService = require('../services/sync');
const demo = require('../services/demo');

const router = express.Router();

/**
 * غلاف أمان لكل معالج غير متزامن:
 * يمنع "تعليق" الطلب عند رمي خطأ غير متوقّع (بدون هذا الغلاف يتحوّل الخطأ
 * إلى رفض وعد غير معالَج ويبقى الاتصال مفتوحاً حتى تنفد مهلة المتصفح).
 */
const asyncRoute = (handler) => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next);
};

/** مُقيّد معدّل الطلبات لحماية السيرفر */
const apiLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.max,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'طلبات كثيرة جداً، انتظر قليلاً ثم أعد المحاولة' },
});

/** مُقيّد أشدّ لإنشاء العناوين (كل بريد = حساب حقيقي لدى المزوّد) */
const createLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { success: false, error: 'لقد أنشأت عدداً كبيراً من العناوين، انتظر دقيقة' },
});

router.use(apiLimiter);

/* ================================= 1) الصحة ================================= */
router.get('/health', (req, res) => {
  const stats = db.stats();
  res.json({
    success: true,
    service: 'ظرف (Zarf Mail)',
    version: '2.0.0',
    provider: config.provider,
    uptime: Math.floor(process.uptime()),
    time: Date.now(),
    smtp: providerManager.localEnabled() && config.smtp.enabled ? config.smtp.port : false,
    ttlMinutes: { mailbox: config.mailboxTtlMinutes, message: config.messageTtlMinutes },
    ttlDays: { mailbox: minutesToDays(config.mailboxTtlMinutes), message: minutesToDays(config.messageTtlMinutes) },
    stats,
    remote: config.provider === 'local' ? null : providerManager.mailtm.describe().client,
  });
});

/* ============================== 2) المزوّد ============================== */
router.get('/provider', (req, res) => {
  res.json({ success: true, data: providerManager.describeAll() });
});

/* ============================== 3) الدومينات ============================== */
router.get('/domains', asyncRoute(async (req, res) => {
  try {
    const provider = providerManager.primary();
    const domains = await provider.listDomains();
    return res.json({
      success: true,
      provider: provider.name,
      real: provider.name !== 'local',
      domains,
      defaultDomain: domains[0],
      allowCustom: config.allowCustomAddress,
      note: provider.name === 'mailtm'
        ? 'النقطة (.) غير مسموحة في الاسم المخصص — تُستبدل تلقائياً بشرطة سفلية'
        : null,
    });
  } catch (error) {
    logger.warn(`تعذّر جلب الدومينات: ${error.message}`);
    return res.json({
      success: true,
      provider: 'local',
      real: false,
      domains: config.domains,
      defaultDomain: config.defaultDomain,
      allowCustom: config.allowCustomAddress,
    });
  }
}))

/* =========================== 4) إنشاء بريد جديد =========================== */
/**
 * POST /api/generate-email
 * body: { "custom": "ahmed", "domain": "emalupe.com" }  ← الحقلان اختياريان
 */
router.post('/generate-email', createLimiter, asyncRoute(async (req, res) => {
  try {
    const { custom, domain } = req.body || {};
    const mailbox = await services.createMailbox({ custom, domain });

    return res.status(201).json({
      success: true,
      message: 'تم إنشاء بريدك المؤقت بنجاح 🎉',
      data: services.serializeMailbox(mailbox, { withToken: true }),
    });
  } catch (error) {
    logger.warn(`فشل إنشاء بريد: ${error.message}`);
    // 429 من الخدمة البعيدة → رسالة ودية للمستخدم
    if (error.status === 429) {
      return res.status(503).json({
        success: false,
        error: 'الخدمة مشغولة لحظياً — أعد المحاولة بعد بضع ثوانٍ',
        retryAfter: error.retryAfter,
      });
    }
    return res.status(error.status || 502).json({ success: false, error: error.message });
  }
}))

/* ======================= 5) middleware: حلّ الصندوق ======================= */
function loadMailbox(req, res, next) {
  const mailbox = services.resolveMailbox(req.params.emailId);
  if (!mailbox) {
    return res.status(404).json({
      success: false,
      code: 'MAILBOX_NOT_FOUND',
      error: 'هذا البريد غير موجود أو انتهت صلاحيته (مدة البريد ساعة واحدة)',
    });
  }
  req.mailbox = mailbox;
  return next();
}

/* ======================== 6) فحص صندوق الوارد ======================== */
/**
 * GET /api/check-inbox/:emailId?sync=1&limit=50&since=0
 *  - sync=1 : يزامن مع خدمة البريد فوراً (مزامنة يدوية عند ضغطة "تحديث")
 *  - since  : يجلب الرسائل الأحدث فقط
 */
router.get('/check-inbox/:emailId', loadMailbox, asyncRoute(async (req, res) => {
  const since = Number(req.query.since) || 0;
  const limit = Math.min(Number(req.query.limit) || 50, 100);
  const wantSync = ['1', 'true', 'yes'].includes(String(req.query.sync || '').toLowerCase());

  let syncInfo = null;
  if (wantSync && req.mailbox.provider !== 'local') {
    const result = await syncService.syncMailbox(req.mailbox, { manual: true });
    syncInfo = { attempted: true, ...result };
  }

  const rows = db.listMessages(req.mailbox.id, { limit, since });
  const messages = rows.map((row) => services.serializeMessage(row));
  const unread = messages.filter((m) => !m.isRead).length;

  res.json({
    success: true,
    data: {
      mailbox: services.serializeMailbox(req.mailbox),
      messages,
      unread,
      sync: syncInfo,
      serverTime: Date.now(),
    },
  });
}))

/* ========================= 7) آخر كود تحقق (OTP) ========================= */
router.get('/inbox/:emailId/otp', loadMailbox, asyncRoute(async (req, res) => {
  const rows = db.listMessages(req.mailbox.id, { limit: 20 });
  const withOtp = rows.find((row) => row.otp_code);
  res.json({
    success: true,
    otp: withOtp
      ? { code: withOtp.otp_code, subject: withOtp.subject, receivedAt: withOtp.received_at, messageId: withOtp.id }
      : null,
  });
}))

/* ====================== 8) تفاصيل رسالة كاملة ====================== */
router.get('/messages/:emailId/:messageId', loadMailbox, asyncRoute(async (req, res) => {
  const message = db.getMessage(req.params.messageId, req.mailbox.id);
  if (!message) {
    return res.status(404).json({ success: false, error: 'الرسالة غير موجودة أو انتهت صلاحيتها' });
  }
  db.markRead(message.id, req.mailbox.id);
  res.json({ success: true, data: services.serializeMessage(message, { withBody: true }) });
}))

/* ========================= 9) تعليم كمقروءة ========================= */
router.post('/messages/:emailId/:messageId/read', loadMailbox, asyncRoute(async (req, res) => {
  db.markRead(req.params.messageId, req.mailbox.id);
  res.json({ success: true });
}))

/* ============================ 10) حذف رسالة ============================ */
router.delete('/messages/:emailId/:messageId', loadMailbox, asyncRoute(async (req, res) => {
  const message = db.getMessage(req.params.messageId, req.mailbox.id);
  const deleted = db.deleteMessage(req.params.messageId, req.mailbox.id);

  // حذف النسخة من الخدمة البعيدة (إن وُجدت)
  if (deleted && message && message.provider !== 'local' && message.provider_id) {
    providerManager.mailtm.deleteMessage(req.mailbox, message.provider_id).catch(() => {});
  }

  res.json({ success: deleted, error: deleted ? undefined : 'الرسالة غير موجودة' });
}))

/* =========================== 11) حذف البريد =========================== */
async function handleDelete(req, res) {
  const mailbox = req.mailbox || services.resolveMailbox(req.params.emailId || (req.body || {}).emailId);
  if (!mailbox) {
    return res.status(404).json({ success: false, error: 'البريد غير موجود أو منتهي الصلاحية' });
  }
  const token = (req.body && req.body.token) || req.get('x-zarf-token');

  if (!services.verifyToken(mailbox, token)) {
    return res.status(403).json({ success: false, error: 'توكن غير صالح — لا يمكن حذف هذا البريد' });
  }

  // حذف الحساب من الخدمة البعيدة (إن كان من mail.tm)
  if (mailbox.provider && mailbox.provider !== 'local') {
    providerManager.mailtm.deleteMailbox(mailbox).catch(() => {});
  }

  const deleted = db.deleteMailbox(mailbox.id);
  logger.info(`🗑  حذف بريد: ${mailbox.address}`);
  return res.json({ success: deleted, message: 'تم حذف البريد وكل رسائله نهائياً' });
}

router.post('/delete-email', asyncRoute(handleDelete));
router.delete('/delete-email', asyncRoute(handleDelete));
router.delete('/delete-email/:emailId', loadMailbox, asyncRoute(handleDelete));

/* ==================== 12) بثّ فوري SSE (تحديث لحظي) ==================== */
router.get('/stream/:emailId', loadMailbox, asyncRoute(async (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  res.write(`event: hello\ndata: ${JSON.stringify({ emailId: req.mailbox.id, time: Date.now() })}\n\n`);

  let lastCount = db.countMessages(req.mailbox.id);
  let lastOtp = null;

  const tick = setInterval(() => {
    try {
      const rows = db.listMessages(req.mailbox.id, { limit: 10 });
      const count = db.countMessages(req.mailbox.id);
      const otpRow = rows.find((r) => r.otp_code);

      if (count !== lastCount || (otpRow && otpRow.otp_code !== lastOtp)) {
        lastCount = count;
        lastOtp = otpRow ? otpRow.otp_code : null;
        res.write(`event: update\ndata: ${JSON.stringify({
          count,
          otp: otpRow ? otpRow.otp_code : null,
          time: Date.now(),
        })}\n\n`);
      } else {
        res.write(`: ping ${Date.now()}\n\n`);
      }
    } catch {
      clearInterval(tick);
    }
  }, 3000);

  req.on('close', () => clearInterval(tick));
}))

/* ================= 13) تجريبي: رسالة اختبار (حقيقية إن أمكن) ================= */
/**
 * POST /api/demo/inject
 *  - مع المزوّد المحلي: يحقن رسالة في قاعدة البيانات مباشرة
 *  - مع mail.tm      : يرسل بريداً حقيقياً إلى عنوانك عبر MX (إن كان البورت 25 مفتوحاً)
 */
router.post('/demo/inject', asyncRoute(async (req, res) => {
  if (config.isProd && !config.demo) {
    return res.status(403).json({ success: false, error: 'متاح في وضع التطوير فقط (DEMO_MODE=true)' });
  }

  const emailId = (req.body || {}).emailId;
  const kind = (req.body || {}).kind || 'otp';
  const mailbox = emailId ? db.getMailboxById(emailId) : db.raw
    .prepare('SELECT * FROM mailboxes ORDER BY created_at DESC LIMIT 1').get();

  if (!mailbox) return res.status(400).json({ success: false, error: 'لا يوجد صندوق بريد — أنشئ بريداً أولاً' });

  try {
    if (mailbox.provider && mailbox.provider !== 'local') {
      // إرسال بريدي حقيقي عبر SMTP مباشر إلى سيرفر الدومين
      const result = await demo.sendRealEmail(mailbox.address, kind);
      return res.status(202).json({
        success: true,
        mode: 'real',
        message: 'تم إرسال رسالة حقيقية — ستصل خلال ثوانٍ',
        to: mailbox.address,
        code: result.code,
        transport: result.transport,
      });
    }

    const result = await demo.injectDemoMessage({ emailId: mailbox.id, kind });
    return res.status(result.success ? 201 : 400).json(result);
  } catch (error) {
    logger.warn(`فشل الرسالة التجريبية: ${error.message}`);
    return res.status(400).json({ success: false, error: error.message });
  }
}))

module.exports = router;
