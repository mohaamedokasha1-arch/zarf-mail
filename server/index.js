/**
 * =============================================================
 *  نقطة الانطلاق — ظرف (Zarf Mail) Server
 * -------------------------------------------------------------
 *  يشغّل:
 *    1) سيرفر HTTP (Express) للواجهة و الـ API
 *    2) سيرفر SMTP لاستقبال الرسائل (اختياري حسب الإعدادات)
 *    3) عامل التنظيف الدوري لحذف ما مضى عليه أكثر من ساعة
 *    4) إيقاف ناعم (Graceful Shutdown) عند إغلاق العملية
 * =============================================================
 */

const http = require('http');
const path = require('path');
const express = require('express');

const config = require('./config');
const logger = require('./lib/logger');
const db = require('./db');
const apiRoutes = require('./routes/api');
const inboundRoutes = require('./routes/inbound');
const { startSmtpServer } = require('./smtp/server');
const { startCleanupJob } = require('./services/cleanup');
const { startSyncWorker, stopSyncWorker } = require('./services/sync');
const providers = require('./providers');
const security = require('./middleware/security');

/* ============================== إنشاء التطبيق ============================== */
const app = express();

security.applySecurity(app);
security.applyParsers(app);
security.applyRequestLogger(app);

/* ================================ المسارات ================================ */
app.use('/api/inbound', inboundRoutes);   // ويب هوك الاستقبال (Cloudflare / Mailgun)
app.use('/api', apiRoutes);               // بقية واجهات API

// الواجهة (ملفات ثابتة: HTML/CSS/JS)
security.applyStatic(app);

// الصفحة الرئيسية + أي مسار غير API (SPA)
app.get('*', (req, res) => {
  res.sendFile(path.join(config.paths.publicDir, 'index.html'));
});

security.applyNotFound(app);
security.applyErrorHandler(app);

/* =============================== الإقلاع =============================== */
const server = http.createServer(app);

// رفع حدّ المستمعين حتى نتحمّل اتصالات SSE الطويلة
server.maxHeadersCount = 1000;
server.setTimeout(120 * 1000);

server.listen(config.port, config.host, () => {
  const line = '─'.repeat(58);
  logger.info(line);
  logger.success(`  ✉️  ظرف (Zarf Mail) يعمل الآن!`);
  logger.info(`  🌐  الواجهة     : ${config.publicUrl}`);
  logger.info(`  🔌  API         : ${config.publicUrl}/api/health`);
  logger.info(`  🛰   مزوّد البريد : ${config.provider.toUpperCase()}${config.provider === 'local' ? '' : ' (دومينات حقيقية)'}`);
  logger.info(`  🌍  الدومين     : ${config.provider === 'local' ? config.domains.join(', ') : 'يُجلب من الخدمة عند أول طلب'}`);
  logger.info(`  ⏳  مدة الحياة   : ${config.mailboxTtlMinutes} دقيقة (${config.mailboxTtlMinutes / 1440} يوم) للبريد والرسائل`);
  if (providers.localEnabled() && config.smtp.enabled) {
    logger.info(`  📬  SMTP محلي   : بورت ${config.smtp.port}`);
  }
  logger.info(line);
});

// سيرفر SMTP (في نفس العملية — يعمل فقط إن كان المزوّد المحلي مفعّلاً)
const smtpServer = startSmtpServer();

// عامل مزامنة الرسائل من الخدمة البعيدة (mail.tm)
startSyncWorker();

// عامل التنظيف الدوري
startCleanupJob();

/* ========================== الإيقاف الناعم ========================== */
function shutdown(signal) {
  logger.warn(`تم استلام إشارة ${signal} — جارٍ الإغلاق بأمان...`);

  stopSyncWorker();

  if (smtpServer) {
    try { smtpServer.close(() => logger.info('تم إغلاق سيرفر SMTP')); } catch { /* تجاهل */ }
  }

  server.close(() => {
    logger.info('تم إغلاق سيرفر HTTP');
    try {
      db.raw.close();
      logger.info('تم إغلاق قاعدة البيانات');
    } catch { /* تجاهل */ }
    process.exit(0);
  });

  // مهلة قصوى: أغلق مهما حدث
  setTimeout(() => process.exit(0), 8000).unref();
}

['SIGINT', 'SIGTERM'].forEach((signal) => {
  process.on(signal, () => shutdown(signal));
});

process.on('unhandledRejection', (reason) => {
  const stack = reason && reason.stack ? `\n${reason.stack}` : '';
  logger.error(`رفض وعد غير معالَج: ${reason && reason.message ? reason.message : reason}${stack}`);
});

process.on('uncaughtException', (error) => {
  logger.error(`استثناء غير مُعالَج: ${error.message}\n${error.stack}`);
});

module.exports = { app, server };
