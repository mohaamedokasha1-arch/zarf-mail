/**
 * =============================================================
 *  ملف الإعدادات المركزي — ظرف (Zarf Mail)
 * -------------------------------------------------------------
 *  يقرأ كل الإعدادات من متغيرات البيئة (ملف .env) ويوفّر قيماً
 *  افتراضية آمنة حتى يعمل المشروع فوراً بدون أي تعديل.
 * =============================================================
 */

require('dotenv').config();

const path = require('path');

/** تحويل نص إلى رقم مع قيمة افتراضية */
const num = (value, fallback) => {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
};

/** تحويل نص إلى قيمة منطقية (true/false) */
const bool = (value, fallback = false) => {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};

/** قائمة الدومينات المسموح استخدامها لتوليد العناوين */
const domains = (process.env.MAIL_DOMAINS || 'zarf.mail')
  .split(',')
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);

const defaultDomain = (process.env.DEFAULT_DOMAIN || domains[0] || 'zarf.mail')
  .trim()
  .toLowerCase();

const config = {
  // ---------- عام ----------
  env: process.env.NODE_ENV || 'development',
  isProd: (process.env.NODE_ENV || 'development') === 'production',
  port: num(process.env.PORT, 3000),
  host: process.env.HOST || '0.0.0.0',
  publicUrl: process.env.PUBLIC_URL || `http://localhost:${num(process.env.PORT, 3000)}`,
  appSecret: process.env.APP_SECRET || 'zarf-dev-secret',

  // ---------- الدومينات ----------
  domains,
  defaultDomain,

  // ---------- مدة الحياة (بالدقائق) ----------
  // ⏳ مدة الصلاحية: 7 أيام كاملة (10080 دقيقة) للبريد وللرسائل
  mailboxTtlMinutes: num(process.env.MAILBOX_TTL_MINUTES, 7 * 24 * 60),
  messageTtlMinutes: num(process.env.MESSAGE_TTL_MINUTES, 7 * 24 * 60),
  // عامل التنظيف: فحص كل ساعة (يحذف فقط ما تجاوز 7 أيام)
  cleanupIntervalMinutes: num(process.env.CLEANUP_INTERVAL_MINUTES, 60),

  // ---------- الحدود والحماية ----------
  maxMessagesPerMailbox: num(process.env.MAX_MESSAGES_PER_MAILBOX, 50),
  maxMessageSize: num(process.env.MAX_MESSAGE_SIZE, 2 * 1024 * 1024), // 2MB
  allowCustomAddress: bool(process.env.ALLOW_CUSTOM_ADDRESS, true),

  // ---------- مزوّد البريد (الأهم) ----------
  // mailtm : خدمة mail.tm (دومينات حقيقية تستقبل من الإنترنت بالكامل) — الأساسي
  // local  : سيرفر SMTP/Webhook المحلي (بدون دومين خارجي)
  // hybrid : الاثنان معاً (mail.tm للبريد الحقيقي + المحلي للاختبار)
  provider: (process.env.MAIL_PROVIDER || 'mailtm').trim().toLowerCase(),

  mailtm: {
    apiBase: (process.env.MAILTM_API_BASE || 'https://api.mail.tm').replace(/\/$/, ''),
    // فاصل زمني أدنى بين جلب الرسائل لكل صندوق (ميلي ثانية)
    pollIntervalMs: num(process.env.MAILTM_POLL_INTERVAL_MS, 8000),
    // كم صندوقاً نزامن في الدورة الواحدة (حسب ميزانية الطلبات)
    maxPerCycle: num(process.env.MAILTM_MAX_MAILBOXES_PER_CYCLE, 8),
    // الصناديق التي لم يُفتح أصحابها خلال هذه الدقائق لا تُزامن (توفير الطلبات)
    activeWindowMinutes: num(process.env.MAILTM_ACTIVE_WINDOW_MIN, 15),
    // ميزانية الطلبات في الدقيقة (الحد الرسمي 30/دقيقة — نترك هامش أمان)
    ratePerMinute: num(process.env.MAILTM_RATE_LIMIT_PER_MIN, 20),
    // تعليم الرسالة كمقروءة على الخدمة البعيدة (طلب إضافي لكل رسالة)
    markSeen: bool(process.env.MAILTM_MARK_SEEN, false),
    // حذف الرسالة/الحساب من الخدمة البعيدة عند انتهاء مدة ظرف (ساعة)
    deleteOnExpire: bool(process.env.MAILTM_DELETE_ON_EXPIRE, true),
    // عدد محاولات الحصول على التوكن (هناك تأخير تنشيط ~3 ثوانٍ بعد إنشاء الحساب)
    tokenAttempts: num(process.env.MAILTM_TOKEN_ATTEMPTS, 5),
    // مدة تخزين قائمة الدومينات في الذاكرة (دقائق)
    domainsCacheMinutes: num(process.env.MAILTM_DOMAINS_CACHE_MINUTES, 15),
    // أقل فاصل بين مزامنة يدوية لنفس الصندوق (ميلي ثانية)
    manualSyncThrottleMs: num(process.env.MAILTM_MANUAL_SYNC_THROTTLE_MS, 3000),
    attribution: 'https://mail.tm',
  },

  // ---------- استقبال البريد ----------
  smtp: {
    enabled: bool(process.env.SMTP_ENABLED, true),
    port: num(process.env.SMTP_PORT, 2525),
    host: process.env.SMTP_HOST || '0.0.0.0',
    acceptAny: bool(process.env.SMTP_ACCEPT_ANY, true),
    banner: 'ظرف Zarf Mail — SMTP Inbound Ready',
  },

  inboundWebhook: {
    enabled: bool(process.env.INBOUND_WEBHOOK_ENABLED, true),
    key: process.env.INBOUND_WEBHOOK_KEY || 'super-secret-webhook-key',
  },

  // ---------- تقييد المعدّل ----------
  rateLimit: {
    windowMs: num(process.env.RATE_LIMIT_WINDOW_MS, 60 * 1000),
    max: num(process.env.RATE_LIMIT_MAX, 120),
  },

  // ---------- مسارات الملفات ----------
  // وضع تجريبي (زر "رسالة تجريبية" في الواجهة)
  demo: bool(process.env.DEMO_MODE, false),

  paths: {
    root: path.join(__dirname, '..'),
    publicDir: path.join(__dirname, '..', 'public'),
    dataDir: process.env.DATA_DIR || path.join(__dirname, '..', 'data'),
    dbFile: process.env.DB_FILE || path.join(__dirname, '..', 'data', 'zarf.db'),
  },
};

module.exports = config;
