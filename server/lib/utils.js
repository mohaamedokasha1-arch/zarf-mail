/**
 * =============================================================
 *  أدوات مساعدة — ظرف (Zarf Mail)
 * -------------------------------------------------------------
 *  - توليد مُعرّفات (IDs) وتوكنات سرية
 *  - توليد أسماء بريد عشوائية "شبابية" ومقروءة
 *  - التحقق من صحة العناوين المُخصصة
 * =============================================================
 */

const crypto = require('crypto');
const config = require('../config');

/**
 * يولّد مُعرّفاً قصيراً آمناً (يستخدم كـ emailId في الواجهة)
 * مثال: k3f9a2b7
 */
function shortId(length = 10) {
  return crypto.randomBytes(length).toString('base64url').slice(0, length).toLowerCase();
}

/** توكن سري لحماية عمليات الحذف */
function secretToken(length = 32) {
  return crypto.randomBytes(length).toString('base64url');
}

/** كلمات عربية/إنجليزية خفيفة تعطي طابعاً شبابياً للبراند */
const ADJECTIVES = [
  'sunny', 'lucky', 'quick', 'bold', 'cool', 'nova', 'pixel', 'swift',
  'amber', 'cobalt', 'zesty', 'lunar', 'saffron', 'mint', 'onyx', 'ivory',
];

const NOUNS = [
  'fox', 'wave', 'spark', 'orbit', 'comet', 'dune', 'reef', 'falcon',
  'pulse', 'drift', 'cipher', 'quest', 'byte', 'flare', 'bloom', 'ridge',
];

/**
 * يولّد الجزء المحلي (local part) للبريد بشكل عشوائي مقروء
 * مثال: nova.falcon.a91f
 */
function randomLocalPart() {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  const suffix = crypto.randomBytes(3).toString('hex'); // 6 أحرف عشوائية
  return `${adj}.${noun}.${suffix}`;
}

/**
 * يتحقق من صحة اسم بريد مخصص يختاره المستخدم
 * @returns {{valid: boolean, reason?: string, value?: string}}
 */
function validateCustomLocalPart(input) {
  if (!config.allowCustomAddress) {
    return { valid: false, reason: 'إنشاء عناوين مخصصة معطّل من إعدادات السيرفر' };
  }
  const value = String(input || '').trim().toLowerCase();

  if (value.length < 3) return { valid: false, reason: 'الاسم قصير جداً (٣ أحرف على الأقل)' };
  if (value.length > 30) return { valid: false, reason: 'الاسم طويل جداً (٣٠ حرفاً كحد أقصى)' };
  if (!/^[a-z0-9._-]+$/.test(value)) {
    return { valid: false, reason: 'يُسمح بالأحرف الإنجليزية والأرقاء والنقطة والشرطة فقط' };
  }
  if (/^[._-]|[._-]$/.test(value)) {
    return { valid: false, reason: 'لا يمكن أن يبدأ الاسم أو ينتهي بنقطة أو شرطة' };
  }
  if (/[._-]{2,}/.test(value)) {
    return { valid: false, reason: 'لا يمكن تكرار النقاط أو الشرطات' };
  }
  return { valid: true, value };
}

/** يختار الدومين المناسب من القائمة المسموحة (إن أُرسل دومين غير مسموح نرجّع الافتراضي) */
function pickDomain(requested) {
  const wanted = String(requested || '').trim().toLowerCase();
  if (wanted && config.domains.includes(wanted)) return wanted;
  return config.defaultDomain;
}

/** يُطبّع عنوان بريد كامل: lowercase + إزالة المسافات */
function normalizeAddress(address) {
  return String(address || '').trim().toLowerCase().replace(/\s+/g, '');
}

/** يفصل عنوان البريد إلى جزء محلي + دومين */
function splitAddress(address) {
  const at = address.lastIndexOf('@');
  if (at === -1) return null;
  return {
    localPart: address.slice(0, at),
    domain: address.slice(at + 1),
  };
}

/** يختصر نصاً طويلاً ليصلح كـ snippet */
function makeSnippet(text, max = 180) {
  if (!text) return '';
  const clean = String(text).replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/** مقارنة آمنة للنصوص (تحمي من توقيت الاستجابة Timing Attack) */
function safeEqual(a = '', b = '') {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** يحول الأرقام العربية (٠١٢٣) إلى لاتينية (0123) */
function arabicDigitsToLatin(input = '') {
  return String(input)
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

/** تأخير زمني (يُستخدم في إعادة المحاولة) */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * يفكّك زمناً متبقياً (بالميلي ثانية) إلى أيام/ساعات/دقائق/ثوانٍ
 * @param {number} ms
 * @returns {{totalMs:number, days:number, hours:number, minutes:number, seconds:number, expired:boolean}}
 */
function breakdownRemaining(ms) {
  const total = Math.max(0, Number(ms) || 0);
  const totalSeconds = Math.floor(total / 1000);
  return {
    totalMs: total,
    days: Math.floor(totalSeconds / 86400),
    hours: Math.floor((totalSeconds % 86400) / 3600),
    minutes: Math.floor((totalSeconds % 3600) / 60),
    seconds: totalSeconds % 60,
    expired: total <= 0,
  };
}

/**
 * تحويل آمن إلى نص ISO — لا يرمي خطأً أبداً (يُرجع null عند قيمة غير صالحة).
 * يحمي الواجهة من انهيار الطلب بسبب "Invalid time value".
 * @param {number|string|Date} value
 * @returns {string|null}
 */
function safeIso(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  const time = date.getTime();
  if (!Number.isFinite(time)) return null;
  try { return date.toISOString(); } catch (e) { return null; }
}

/** يحوّل الدقائق إلى عدد أيام (تقريبي لتقريب للعرض) */
const minutesToDays = (minutes) => Math.round((Number(minutes) / (24 * 60)) * 10) / 10;

module.exports = {
  shortId,
  secretToken,
  randomLocalPart,
  validateCustomLocalPart,
  pickDomain,
  normalizeAddress,
  splitAddress,
  makeSnippet,
  safeEqual,
  arabicDigitsToLatin,
  sleep,
  breakdownRemaining,
  minutesToDays,
  safeIso,
};
