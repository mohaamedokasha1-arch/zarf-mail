/**
 * =============================================================
 *  عميل HTTP ذكي + محدّد معدّل (Rate Limiter)
 * -------------------------------------------------------------
 *  خدمة mail.tm تسمح بـ 30 طلباً في الدقيقة لكل IP
 *  (ولو زادت ترجع 429 Too Many Requests).
 *
 *  لذلك بنينا:
 *    1) Token Bucket: ميزانية طلبات تتجدّد تدريجياً ولا تتجاوز الحد أبداً
 *    2) إعادة محاولة مع Backoff عند 429 مع احترام ترويسة Retry-After
 *    3) تحديث التوكن تلقائياً عند 401 ثم إعادة الطلب مرة واحدة
 *    4) تسجيل كل الطلبات لأغراض التشخيص (DEBUG)
 * =============================================================
 */

const config = require('../config');
const logger = require('../lib/logger');
const { sleep } = require('../lib/utils');

/** ====================== محدّد المعدّل (Token Bucket) ====================== */
class RateLimiter {
  /**
   * @param {number} perMinute أقصى عدد طلبات في الدقيقة
   */
  constructor(perMinute) {
    this.capacity = Math.max(1, perMinute);
    this.tokens = this.capacity;
    this.refillPerMs = this.capacity / 60000; // عدد الرموز المضافة كل ميلي ثانية
    this.lastRefill = Date.now();
    this.cooldownUntil = 0; // فترة تبريد بعد خطأ 429
  }

  /** يضيف الرموز المستحقة حسب الزمن المنقضي */
  refill() {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
    this.lastRefill = now;
  }

  /** كم رمزاً متاحاً الآن (تقريبي) */
  available() {
    this.refill();
    return Math.floor(this.tokens);
  }

  /** يفرض فترة تبريد (بعد 429 مثلًا) */
  cooldown(ms) {
    this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + ms);
    logger.warn(`⏸  تبريد ${Math.round(ms / 1000)} ثانية احتراماً لحدّ الطلبات`);
  }

  /** ينتظر حتى يتوفر رمز واحد على الأقل ثم يستهلكه */
  async acquire() {
    for (;;) {
      this.refill();
      const waitCooldown = this.cooldownUntil - Date.now();
      if (this.tokens >= 1 && waitCooldown <= 0) {
        this.tokens -= 1;
        return;
      }
      const waitMs = waitCooldown > 0 ? waitCooldown : Math.ceil((1 - this.tokens) / this.refillPerMs);
      await sleep(Math.min(Math.max(waitMs, 50), 5000));
    }
  }
}

/** ====================== عميل HTTP ====================== */
class HttpClient {
  /**
   * @param {{baseUrl: string, ratePerMinute: number}} options
   */
  constructor({ baseUrl, ratePerMinute }) {
    this.baseUrl = baseUrl;
    this.limiter = new RateLimiter(ratePerMinute);
    this.stats = { requests: 0, errors: 0, retries: 0, lastError: null, lastRequestAt: 0 };
  }

  /**
   * تنفيذ طلب HTTP مع إعادة المحاولة
   * @param {string} path المسار (يبدأ بـ /)
   * @param {object} options
   * @param {string} [options.method]
   * @param {object|string} [options.body]
   * @param {string} [options.token] توكن Bearer
   * @param {number} [options.attempts] عدد المحاولات عند الأخطاء المؤقتة
   * @param {boolean} [options.skipRateLimit] تجاوز المحدّد (للحالات الحرجة فقط)
   * @param {Function} [options.onUnauthorized] تُستدعى عند 401 لتحديث التوكن
   */
  async request(path, options = {}) {
    const {
      method = 'GET',
      body = undefined,
      token = null,
      attempts = 3,
      skipRateLimit = false,
      onUnauthorized = null,
      headers = {},
      timeoutMs = 20000,
    } = options;

    let lastError = null;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (!skipRateLimit) await this.limiter.acquire();

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const res = await fetch(`${this.baseUrl}${path}`, {
          method,
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/ld+json, application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...headers,
          },
          body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
          signal: controller.signal,
        });

        this.stats.requests += 1;
        this.stats.lastRequestAt = Date.now();
        clearTimeout(timer);

        // ---- 429: تجاوز حد الطلبات ----
        if (res.status === 429) {
          const retryAfter = Number(res.headers.get('retry-after')) || 5;
          this.limiter.cooldown(retryAfter * 1000);
          this.stats.retries += 1;
          if (attempt < attempts) {
            // ننتظر ثم نعيد المحاولة داخل نفس الطلب (بحد أقصى 12 ثانية)
            await sleep(Math.min(retryAfter * 1000, 12000));
            continue;
          }
          const error = new Error('الخدمة مشغولة لحظياً (تم تجاوز حد الطلبات) — أعد المحاولة بعد ثوانٍ');
          error.status = 429;
          error.retryAfter = retryAfter;
          this.stats.errors += 1;
          throw error;
        }

        // ---- 401: توكن منتهٍ أو غير صالح ----
        if (res.status === 401 && onUnauthorized) {
          const newToken = await onUnauthorized();
          if (newToken) {
            this.stats.retries += 1;
            // نعيد المحاولة فوراً بالتوكن الجديد (دون حسابها كمحاولة فاشلة)
            return this.request(path, { ...options, token: newToken, onUnauthorized: null, attempts: Math.max(1, attempts - 1) });
          }
        }

        // ---- 5xx: خطأ مؤقت في الخدمة ----
        if (res.status >= 500) {
          lastError = new Error(`خطأ في الخدمة البعيدة (${res.status})`);
          this.stats.retries += 1;
          await sleep(800 * attempt);
          continue;
        }

        // ---- الاستجابة الناجحة (أو خطأ نهائي من التطبيق) ----
        const text = await res.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = text; }

        if (!res.ok) {
          const message = (data && (data.message || data.detail || data.title)) || `HTTP ${res.status}`;
          const error = new Error(message);
          error.status = res.status;
          error.payload = data;
          this.stats.errors += 1;
          this.stats.lastError = message;
          throw error;
        }

        return data;
      } catch (error) {
        clearTimeout(timer);
        lastError = error;
        if (error.status) throw error; // خطأ تطبيقي (400/404…) لا نعيد المحاولة عليه

        // خطأ شبكة/مهلة → إعادة محاولة مع backoff
        if (attempt < attempts) {
          this.stats.retries += 1;
          await sleep(700 * attempt);
          continue;
        }
      }
    }

    this.stats.errors += 1;
    this.stats.lastError = lastError ? lastError.message : 'unknown';
    throw lastError || new Error('فشل الطلب');
  }

  /** ملخّص حالة العميل (يظهر في /api/health) */
  health() {
    return {
      availableTokens: this.limiter.available(),
      cooldownMs: Math.max(0, this.limiter.cooldownUntil - Date.now()),
      ...this.stats,
    };
  }
}

module.exports = { HttpClient, RateLimiter, client: new HttpClient({
  baseUrl: config.mailtm.apiBase,
  ratePerMinute: config.mailtm.ratePerMinute,
}) };
