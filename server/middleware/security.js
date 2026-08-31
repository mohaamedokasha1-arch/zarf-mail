/**
 * =============================================================
 *  طبقة الحماية والأداء — ظرف (Zarf Mail)
 * -------------------------------------------------------------
 *  - Helmet: ترويسات حماية + سياسة المحتوى (CSP)
 *  - CORS: السماح للواجهة (ونطاقاتك) بالوصول
 *  - Compression: ضغط الاستجابات (سرعة أكبر)
 *  - التحقق من حجم الأجسام (JSON) وحماية من الطلبات الضخمة
 *  - مسجّل طلبات مختصر + معالج أخطاء موحّد
 * =============================================================
 */

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const config = require('../config');
const logger = require('../lib/logger');

/** إعداد Helmet وسياسة المحتوى */
function applySecurity(app) {
  app.disable('x-powered-by');               // إخفاء توقيع Express
  app.set('trust proxy', 1);                 // مهم خلف البروكسي (Render/Railway/Cloudflare)

  app.use(helmet({
    // السماح بتضمين الموقع داخل iframe (يفيد المعاينات ويمنع كسرها)
    frameguard: false,
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],                       // كل الأكواد في ملفات خارجية
        styleSrc: ["'self'", "'unsafe-inline'"],      // Tailwind + أنماط مضمّنة للرسائل
        imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],                       // SSE + API
        frameSrc: ["'self'", 'data:'],                // srcdoc لعرض رسائل HTML
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["*"],
        upgradeInsecureRequests: config.isProd ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  }));

  app.use(cors({
    origin: true,          // API عام: نسمح للجميع (بلا كوكيز/جلسات)
    credentials: false,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'x-zarf-token', 'x-zarf-webhook-key'],
  }));

  app.use(compression());
}

/** المحلّلات + حدود الأحجام */
function applyParsers(app) {
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));
}

/** مسجّل طلبات خفيف (لا يسجّل مسارات الأصول الثابتة) */
function applyRequestLogger(app) {
  app.use((req, res, next) => {
    if (req.path.startsWith('/assets') || req.path === '/favicon.svg') return next();
    const start = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - start;
      if (!config.isProd || res.statusCode >= 400) {
        logger.debug(`${req.method} ${req.originalUrl} → ${res.statusCode} (${ms}ms)`);
      }
    });
    return next();
  });
}

/** تقديم الملفات الثابتة (الواجهة) */
function applyStatic(app) {
  app.use(express.static(config.paths.publicDir, {
    index: false,
    maxAge: config.isProd ? '1h' : 0,
    setHeaders(res, filePath) {
      // منع تخزين صفحات HTML وservice worker
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      }
    },
  }));
}

/** معالج "غير موجود" لمسارات /api */
function applyNotFound(app) {
  app.use('/api', (req, res) => {
    res.status(404).json({ success: false, error: `المسار غير موجود: ${req.originalUrl}` });
  });
}

/** معالج الأخطاء الموحّد */
function applyErrorHandler(app) {
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    logger.error(`${req.method} ${req.originalUrl} → ${err.message}`);

    if (res.headersSent) return next(err);

    if (req.path.startsWith('/api')) {
      return res.status(status).json({
        success: false,
        error: config.isProd ? 'حدث خطأ في السيرفر' : err.message,
      });
    }
    return res.status(status).sendFile(path.join(config.paths.publicDir, 'index.html'));
  });
}

module.exports = {
  applySecurity,
  applyParsers,
  applyRequestLogger,
  applyStatic,
  applyNotFound,
  applyErrorHandler,
};
