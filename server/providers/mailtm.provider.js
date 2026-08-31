/**
 * =============================================================
 *  مزوّد الخدمة الأساسي: mail.tm  (https://api.mail.tm)
 * -------------------------------------------------------------
 *  هذه هي طبقة الاتصال بالخدمة التي يبني عليها ظرف كل شيء:
 *
 *    1) GET  /domains              → الدومينات الحقيقية المتاحة
 *    2) POST /accounts             → إنشاء حساب (address + password)
 *    3) POST /token                → الحصول على توكن JWT
 *    4) GET  /messages             → قائمة الرسائل (Bearer TOKEN)
 *    5) GET  /messages/{id}        → محتوى الرسالة كاملاً
 *    6) PATCH /messages/{id}       → تعليم كمقروءة
 *    7) DELETE /messages/{id}      → حذف رسالة
 *    8) DELETE /accounts/{id}      → حذف الحساب بالكامل
 *
 *  ⚠️  اكتشافات مهمة من الاختبار الحقيقي للخدمة (مُطبّقة في الكود):
 *    أ) النقطة (.) في اسم المستخدم تُفشل /token دائماً (401)
 *       مع أن /accounts يقبلها → لذلك نستخدم _ أو - ولا نستخدم النقطة أبداً.
 *    ب) بعد إنشاء الحساب هناك تأخير تنشيط ~3 ثوانٍ قبل أن يعمل /token
 *       → لذلك نعيد المحاولة بفواصل متزايدة.
 *    ج) الحد الرسمي 30 طلب/دقيقة لكل IP → نتعامل معه بمحدّد معدّل صارم.
 *    د) حقل html في الرسالة الكاملة يأتي كمصفوفة نصوص وليس نصاً واحداً.
 * =============================================================
 */

const crypto = require('crypto');
const config = require('../config');
const logger = require('../lib/logger');
const { client } = require('./http-client');
const { sleep } = require('../lib/utils');

const NAME = 'mailtm';

/** ============================== ذاكرة الدومينات ============================== */
let domainsCache = {
  list: [],
  fetchedAt: 0,
};

/** أصناف الكلمات لتوليد أسماء مقروءة (بدون نقاط!) */
const WORDS_A = ['nova', 'pixel', 'swift', 'amber', 'cobalt', 'zesty', 'lunar', 'mint', 'onyx', 'ivory', 'saffron', 'reef'];
const WORDS_B = ['fox', 'wave', 'spark', 'orbit', 'comet', 'dune', 'falcon', 'pulse', 'drift', 'cipher', 'quest', 'byte'];

/**
 * يُطبّع الجزء المحلي: lowercase + إزالة غير المسموح
 * ⚠️ النقطة تُستبدل بشرطة سفلية (لأنها تُفشل /token على الخدمة)
 */
function normalizeLocalPart(input) {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/\./g, '_')            // ← الشرط القاتل: لا نقاط
    .replace(/[^a-z0-9_-]/g, '')    // لا رموز أخرى
    .replace(/^[_-]+|[_-]+$/g, '')  // لا تبدأ/تنتهي بفاصل
    .replace(/[_-]{2,}/g, '_')      // لا فواصل مكررة
    .slice(0, 30);
}

/**
 * يتحقق من اسم مخصص يطلبه المستخدم (مع تحويل النقطة تلقائياً)
 * @returns {{ok: boolean, value?: string, reason?: string}}
 */
function validateCustomLocal(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return { ok: false, reason: 'اكتب اسماً أولاً' };
  if (raw.length < 3) return { ok: false, reason: 'الاسم قصير جداً (٣ أحرف على الأقل)' };
  if (raw.length > 30) return { ok: false, reason: 'الاسم طويل جداً (٣٠ حرفاً كحد أقصى)' };

  // النقطة مسموحة كمدخل وتُحوّل إلى شرطة سفلية
  const expected = raw.replace(/\./g, '_');
  const normalized = normalizeLocalPart(raw);

  if (normalized !== expected) {
    return {
      ok: false,
      reason: 'يُسمح بالأحرف الإنجليزية والأرقام والشرطة السفلية (_) والشرطة (-) فقط — النقطة تتحول إلى _',
    };
  }
  if (normalized.length < 3) return { ok: false, reason: 'الاسم قصير جداً بعد التنظيف' };

  return { ok: true, value: normalized };
}

/** يولّد جزءاً محلياً عشوائياً مقروءاً: nova.falcon → nova_falcon_a91f2b */
function randomLocalPart() {
  const a = WORDS_A[crypto.randomInt(0, WORDS_A.length)];
  const b = WORDS_B[crypto.randomInt(0, WORDS_B.length)];
  const suffix = crypto.randomBytes(3).toString('hex');
  return `${a}_${b}_${suffix}`.slice(0, 30);
}

/** كلمة مرور قوية للحساب المؤقت (12-18 حرفاً) */
function randomPassword() {
  return 'Zf' + crypto.randomBytes(9).toString('base64url').replace(/[^A-Za-z0-9]/g, '') + '9a';
}

/** ============================== 1) الدومينات ============================== */
async function listDomains({ force = false } = {}) {
  const age = Date.now() - domainsCache.fetchedAt;
  if (!force && domainsCache.list.length && age < config.mailtm.domainsCacheMinutes * 60 * 1000) {
    return domainsCache.list;
  }

  const data = await client.request('/domains', { attempts: 3 });
  const list = (data['hydra:member'] || [])
    .filter((d) => d.isActive && !d.isPrivate)
    .map((d) => String(d.domain).toLowerCase());

  if (!list.length) throw new Error('لا توجد دومينات متاحة حالياً على خدمة mail.tm');

  domainsCache = { list, fetchedAt: Date.now() };
  logger.success(`🌍 دومينات mail.tm: ${list.join(', ')}`);
  return list;
}

/** ============================== 2) التوكن ============================== */
/**
 * يحصل على التوكن بعد إنشاء الحساب.
 * ⚠️ الخدمة تحتاج ~3 ثوانٍ قبل أن تعتمد بيانات الحساب الجديد،
 *    لذلك ننتظر ثم نعيد المحاولة بفواصل متزايدة (ونتجنّب الرشق الذي قد يسبب قفلاً).
 */
async function obtainToken(address, password) {
  const waits = [3500, 4000, 5000, 7000, 9000];
  const attempts = Math.min(config.mailtm.tokenAttempts, waits.length);

  for (let i = 0; i < attempts; i++) {
    await sleep(waits[i]);
    try {
      const data = await client.request('/token', {
        method: 'POST',
        body: { address, password },
        attempts: 1, // لا نعيد المحاولة داخلياً: نتحكم نحن بالفواصل
      });
      if (data && data.token) {
        logger.debug(`🔑 توكن جديد لـ ${address} (محاولة ${i + 1})`);
        return { token: data.token, accountId: data.id };
      }
    } catch (error) {
      logger.debug(`محاولة توكن ${i + 1} فاشلة لـ ${address}: ${error.message}`);
    }
  }
  throw new Error('تعذّر الحصول على توكن من mail.tm (حاول مرة أخرى)');
}

/** ============================== 3) إنشاء صندوق ============================== */
async function createMailbox({ custom, domain } = {}) {
  const domains = await listDomains();
  const wantedDomain = domain && domains.includes(String(domain).toLowerCase())
    ? String(domain).toLowerCase()
    : domains[0];

  let localPart;
  if (custom) {
    // نتحقق من الاسم المخصص ونحوّل النقطة إلى شرطة سفلية
    const check = validateCustomLocal(custom);
    if (!check.ok) {
      const err = new Error(check.reason);
      err.status = 400;
      throw err;
    }
    localPart = check.value;
  } else {
    localPart = randomLocalPart();
  }

  let lastError = null;
  // نجرّب حتى 3 مرات باسم مختلف إن كان الاسم محجوزاً
  for (let attempt = 0; attempt < 3; attempt++) {
    const candidate = attempt === 0 ? localPart : randomLocalPart();
    const address = `${candidate}@${wantedDomain}`;
    const password = randomPassword();

    // فحص محلي قبل استهلاك طلب من الخدمة البعيدة
    // eslint-disable-next-line global-require
    const db = require('../db');
    if (db.getMailboxByAddress(address)) {
      const err = new Error('هذا العنوان مستخدم حالياً، جرّب اسماً آخر');
      err.status = 409;
      throw err;
    }

    try {
      const account = await client.request('/accounts', {
        method: 'POST',
        body: { address, password },
        attempts: 3, // قد نصادف 429 مؤقتاً → نعيد المحاولة مع التبريد
      });

      if (!account || !account.id) throw new Error('استجابة غير متوقعة من /accounts');

      const { token } = await obtainToken(address, password);

      return {
        provider: NAME,
        address,
        localPart: candidate,
        domain: wantedDomain,
        providerId: account.id,
        password,
        token,
      };
    } catch (error) {
      lastError = error;
      // 409 = تكرار محلي (موجود في قاعدة بيانات ظرف) → نوقف فوراً ونُبلغ المستخدم
      if (error.status === 409) throw error;
      // 422 = العنوان مستخدم لدى الخدمة البعيدة → نجرّب اسماً آخر
      if (error.status === 422) {
        logger.warn(`العنوان ${address} مستخدم لدى mail.tm — نجرّب اسماً آخر`);
        continue;
      }
      throw error;
    }
  }
  throw lastError || new Error('تعذّر إنشاء الحساب على mail.tm');
}

/** ============================== 4) تجهيز الرسائل ============================== */
/** يحوّل رسالة من صيغة mail.tm إلى الصيغة الموحّدة في ظرف */
function normalizeMessage(raw) {
  const html = Array.isArray(raw.html)
    ? raw.html.join('\n')
    : (typeof raw.html === 'string' ? raw.html : '');

  return {
    providerId: raw.id,
    from: {
      name: (raw.from && raw.from.name) || '',
      address: (raw.from && raw.from.address) || 'unknown',
    },
    to: (raw.to && raw.to[0] && raw.to[0].address) || (raw.to && raw.to.address) || '',
    subject: raw.subject || '(بدون موضوع)',
    text: raw.text || '',
    html,
    receivedAt: Date.parse(raw.createdAt) || Date.now(),
    size: raw.size || 0,
    attachments: Array.isArray(raw.attachments)
      ? raw.attachments.map((a) => ({
          id: a.id,
          filename: a.filename || 'مرفق',
          contentType: a.contentType || 'application/octet-stream',
          size: a.size || 0,
        }))
      : [],
    raw,
  };
}

/**
 * يجلب قائمة الرسائل من الخدمة (طلب واحد فقط)
 */
async function listMessages(mailbox) {
  const data = await client.request('/messages?page=1', {
    token: mailbox.token,
    attempts: 2,
    onUnauthorized: () => refreshToken(mailbox),
  });
  return (data['hydra:member'] || []).map(normalizeMessage);
}

/** يجلب رسالة كاملة (محتوى النص/HTML) */
async function getMessage(mailbox, providerId) {
  const data = await client.request(`/messages/${providerId}`, {
    token: mailbox.token,
    attempts: 2,
    onUnauthorized: () => refreshToken(mailbox),
  });
  return normalizeMessage(data);
}

/** ============================== 5) تحديث التوكن ============================== */
async function refreshToken(mailbox) {
  try {
    const data = await client.request('/token', {
      method: 'POST',
      body: { address: mailbox.address, password: mailbox.password },
      attempts: 1,
    });
    if (data && data.token) {
      logger.info(`♻️  تحديث توكن: ${mailbox.address}`);
      // نحفظ التوكن الجديد في قاعدة البيانات حتى لا نعيد الطلب كل مرة
      try {
        const db = require('../db');
        db.setToken(mailbox.id, data.token);
        mailbox.token = data.token;
      } catch (e) { /* تجاهل */ }
      return data.token;
    }
  } catch (error) {
    logger.warn(`فشل تحديث التوكن لـ ${mailbox.address}: ${error.message}`);
  }
  return null;
}

/** ============================== 6) العمليات على الرسائل ============================== */
async function markSeen(mailbox, providerId) {
  if (!config.mailtm.markSeen) return false;
  try {
    await client.request(`/messages/${providerId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/merge-patch+json' },
      body: { seen: true },
      token: mailbox.token,
      attempts: 1,
      onUnauthorized: () => refreshToken(mailbox),
    });
    return true;
  } catch (error) {
    logger.debug(`تعذّر تعليم الرسالة كمقروءة: ${error.message}`);
    return false;
  }
}

async function deleteMessage(mailbox, providerId) {
  try {
    await client.request(`/messages/${providerId}`, {
      method: 'DELETE',
      token: mailbox.token,
      attempts: 1,
      onUnauthorized: () => refreshToken(mailbox),
    });
    return true;
  } catch (error) {
    logger.debug(`تعذّر حذف الرسالة من mail.tm: ${error.message}`);
    return false;
  }
}

/** ============================== 7) حذف الحساب ============================== */
async function deleteMailbox(mailbox) {
  if (!mailbox.provider_id) return false;
  try {
    await client.request(`/accounts/${mailbox.provider_id}`, {
      method: 'DELETE',
      token: mailbox.token,
      attempts: 1,
      onUnauthorized: () => refreshToken(mailbox),
    });
    logger.info(`🗑  حذف الحساب من mail.tm: ${mailbox.address}`);
    return true;
  } catch (error) {
    logger.warn(`تعذّر حذف الحساب من mail.tm: ${error.message}`);
    return false;
  }
}

/** ============================== تشخيص ============================== */
function describe() {
  return {
    name: NAME,
    label: 'mail.tm',
    realDomains: true,
    website: config.mailtm.attribution,
    client: client.health(),
    cache: {
      domains: domainsCache.list,
      fetchedAt: domainsCache.fetchedAt,
      ageMinutes: domainsCache.fetchedAt ? Math.round((Date.now() - domainsCache.fetchedAt) / 60000) : null,
    },
    settings: {
      pollIntervalMs: config.mailtm.pollIntervalMs,
      ratePerMinute: config.mailtm.ratePerMinute,
      activeWindowMinutes: config.mailtm.activeWindowMinutes,
      markSeen: config.mailtm.markSeen,
      deleteOnExpire: config.mailtm.deleteOnExpire,
    },
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
  normalizeLocalPart,
  validateCustomLocal,
  randomLocalPart,
  describe,
};
