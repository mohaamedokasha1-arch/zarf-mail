/**
 * =============================================================
 *  استخراج أكواد التحقق (OTP) — ظرف
 * -------------------------------------------------------------
 *  هذه الوحدة هي "الميزة التي تكسر الروتين":
 *  تمر على موضوع الرسالة ثم نصها، وتبحث عن أكواد التحقق
 *  بالاعتماد على:
 *    1) الكلمات المفتاحية (code, OTP, verify, رمز, كود, تحقق...)
 *    2) شكل السطر (سطر قصير يحتوي أرقاماً فقط)
 *    3) طول الكود (4 إلى 8 أرقام) واستبعاد السنوات والأسعار والتواريخ
 *  وتُرجع أفضل مرشّح مع "السياق" الذي ورد فيه الكود.
 * =============================================================
 */

const { arabicDigitsToLatin } = require('./utils');

/** كلمات مفتاحية عربية وإنجليزية تدل على وجود كود تحقق */
const KEYWORDS = [
  'verification code', 'verify code', 'confirmation code', 'security code',
  'one-time', 'one time', 'one-time password', 'one time password', 'otp',
  'passcode', 'access code', 'login code', 'sign in code', 'signin code',
  'activation code', 'pin code', 'code', 'pin', 'token',
  'رمز التحقق', 'رمز التفعيل', 'رمز التأكيد', 'كود التحقق', 'كود التفعيل',
  'كود التأكيد', 'رمز الدخول', 'كود الدخول', 'رمز', 'كود', 'التحقق', 'تفعيل',
];

/** كلمات تستبعد النتيجة (روابط إلغاء الاشتراك، أرقام طلبات...) */
const NEGATIVE_HINTS = [
  'unsubscribe', 'order number', 'invoice', 'tracking', 'http://', 'https://',
  'رقم الطلب', 'الفاتورة', 'إلغاء الاشتراك',
];

/**
 * يحوّل مستند HTML إلى نص بسيط (بدون أي مكتبة خارجية)
 * يُستخدم لأننا نحتاج نصاً سريعاً للبحث عن الكود
 */
function htmlToText(html = '') {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, ' ');
}

/**
 * يفحص إن كان الرقم يبدو "سنة" أو "تاريخ" أو "سعر" أو جزءاً من رقم أطول
 */
function looksLikeNoise(code, context = '') {
  const n = Number(code);
  // سنوات 1900 → 2099
  if (code.length === 4 && n >= 1900 && n <= 2099) {
    // اسمح به فقط إن كانت بجانبه كلمة مفتاحية قوية
    if (!/(code|otp|pin|رمز|كود)/i.test(context)) return true;
  }
  // أرقام متكررة مثل 0000 أو 1111
  if (/^(\d)\1+$/.test(code)) return true;
  // رقم يسبقه أو يليه رقم أو حرف (مثل 12345 داخل 9912345)
  const idx = context.indexOf(code);
  if (idx > -1) {
    const before = context[idx - 1];
    const after = context[idx + code.length];
    if (before && /[\d.,]/.test(before)) return true;
    if (after && /[\d.,]/.test(after)) return true;
    if (before && /[A-Za-z]/.test(before) && after && /[A-Za-z]/.test(after)) return true;
  }
  // سعر أو نسبة
  if (new RegExp(`(?:\\$|USD|SAR|EGP|EUR|%\\s*)${code}|${code}\\s*(?:%|SAR|EGP|USD|\\$)`).test(context)) {
    return true;
  }
  return false;
}

/**
 * يبحث عن الأكواد داخل نص واحد ويعيد مصفوفة مرشحين مع نقاط (score)
 */
function collectCandidates(text, baseScore) {
  const results = [];
  if (!text) return results;

  const normalized = arabicDigitsToLatin(text);
  const lines = normalized.split(/\r?\n/);

  lines.forEach((rawLine, lineIndex) => {
    const line = rawLine.trim();
    if (!line || line.length > 220) return;

    const hasKeyword = KEYWORDS.some((k) => line.toLowerCase().includes(k));
    const hasNegative = NEGATIVE_HINTS.some((k) => line.toLowerCase().includes(k));
    if (hasNegative) return;

    // سطر يحتوي أرقاماً فقط (أو أرقاماً مع مسافات/شرطات بينها) → أقوى إشارة
    const onlyDigitsLine = /^[0-9\s-]{4,12}$/.test(line) && /[0-9]{4,}/.test(line.replace(/[\s-]/g, ''));

    const regex = /(?<![\d.,])([0-9]{4,8})(?![\d.,])/g;
    let match;
    while ((match = regex.exec(line)) !== null) {
      const code = match[1];
      const context = line.slice(Math.max(0, match.index - 60), match.index + code.length + 60);

      if (looksLikeNoise(code, line)) continue;

      let score = baseScore;
      if (hasKeyword) score += 45;
      if (onlyDigitsLine) score += 30;
      if (code.length === 6) score += 12;      // 6 أرقام هو الطول الأكثر شيوعاً
      else if (code.length === 4 || code.length === 5) score += 8;
      else if (code.length === 7 || code.length === 8) score += 4;
      if (lineIndex < 12) score += 6;           // الكود غالباً في أعلى الرسالة
      if (/\b(code|otp|pin|رمز|كود)\b/i.test(context)) score += 15;

      results.push({ code, score, context: context.trim() });
    }
  });

  return results;
}

/**
 * الدالة الرئيسية: تستخرج كود التحقق من رسالة كاملة
 * @param {{subject?: string, text?: string, html?: string}} message
 * @returns {{code: string, context: string, source: string, score: number}|null}
 */
function extractOtp(message = {}) {
  const subject = arabicDigitsToLatin(message.subject || '');
  const body = arabicDigitsToLatin(
    (message.text && message.text.trim()) || htmlToText(message.html || '')
  );

  const candidates = [
    ...collectCandidates(subject, 40),        // الموضوع له وزن أعلى
    ...collectCandidates(body, 0),
  ];

  if (!candidates.length) return null;

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];

  // حد أدنى للثقة حتى لا نظهر أرقاماً عشوائية للمستخدم
  if (best.score < 35) return null;

  return {
    code: best.code,
    context: best.context,
    source: subject.includes(best.code) && subject.includes(best.context.split(' ')[0] || '') ? 'subject' : 'body',
    score: best.score,
  };
}

module.exports = { extractOtp, htmlToText, KEYWORDS };
