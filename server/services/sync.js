/**
 * =============================================================
 *  عامل المزامنة (Sync Worker) — ظرف + mail.tm
 * -------------------------------------------------------------
 *  خدمة mail.tm لا تدفع الرسائل إلينا (لا Webhook للسيرفرات)،
 *  لذلك نستخدم "استقصاءً ذكياً" يحترم حدّ 30 طلب/دقيقة:
 *
 *   • نزامن فقط الصناديق النشطة (صاحبها فتح الموقع خلال آخر 15 دقيقة)
 *   • الأقل مزامنةً أولاً (عدالة في توزيع الطلبات)
 *   • نستهلك من "ميزانية طلبات" واحدة مشتركة (Token Bucket)
 *   • نخزّن كل رسالة جديدة في SQLite ونستخرج كود OTP فوراً
 *   • الواجهة تقرأ من SQLite (وليس من mail.tm) → تحديث رخيص وسريع
 *
 *  النتيجة: وصول الرسائل في ~3 إلى 8 ثوانٍ من لحظة إرسالها.
 * =============================================================
 */

const config = require('../config');
const db = require('../db');
const logger = require('../lib/logger');
const providers = require('../providers');
const { client } = require('../providers/http-client');
const { extractOtp } = require('../lib/otp');
const { sanitizeMessageHtml } = require('../lib/sanitize');
const { shortId, makeSnippet } = require('../lib/utils');
const { htmlToText } = require('../lib/otp');

const MINUTE = 60 * 1000;
/** أقصى عدد رسائل كاملة نجلبها في دورة واحدة (حماية للميزانية) */
const MAX_NEW_PER_CYCLE = 5;

let timer = null;
const lastManualSync = new Map();

/** هل يمكننا استهلاك طلب الآن؟ */
function hasBudget() {
  return client.limiter.available() >= 1;
}

/** يخزّن رسالة قادمة من المزوّد في قاعدة بيانات ظرف */
function storeRemoteMessage(mailbox, message) {
  const safeHtml = sanitizeMessageHtml(message.html || '');
  const textBody = String(message.text || '').slice(0, 200000);
  const otp = extractOtp({ subject: message.subject, text: textBody, html: message.html || '' });

  const payload = {
    id: shortId(14),
    mailboxId: mailbox.id,
    messageId: message.raw && message.raw.msgid ? String(message.raw.msgid).slice(0, 300) : null,
    fromName: (message.from.name || '').slice(0, 150),
    fromAddress: (message.from.address || 'unknown').slice(0, 200),
    toAddress: (message.to || mailbox.address).slice(0, 200),
    subject: String(message.subject || '(بدون موضوع)').slice(0, 500),
    textBody,
    htmlBody: safeHtml,
    snippet: makeSnippet(textBody || htmlToText(safeHtml), 180),
    otpCode: otp ? otp.code : null,
    otpContext: otp ? (otp.context || '').slice(0, 300) : null,
    receivedAt: message.receivedAt || Date.now(),
    expiresAt: Date.now() + config.messageTtlMinutes * MINUTE,
    size: message.size || Buffer.byteLength(textBody + safeHtml, 'utf8'),
    rawHeaders: null,
    attachments: (message.attachments || []).slice(0, 20),
    provider: mailbox.provider || 'mailtm',
    providerId: message.providerId || null,
  };

  try {
    db.insertMessage(payload);
  } catch (error) {
    // سباق بين مزامنتين متوازيتين (يدوية + دورية) على نفس الرسالة: نتجاهلها بصمت
    if (String(error.message || '').includes('UNIQUE')) {
      logger.debug(`رسالة مكرّرة تم تجاهلها: ${message.providerId}`);
      return null;
    }
    throw error;
  }

  logger.mail(`📨 ${mailbox.address} ← ${message.from.address} | ${String(message.subject).slice(0, 60)}${otp ? ` | OTP: ${otp.code}` : ''}`);
  return otp;
}

/**
 * يزامن صندوقاً واحداً مع الخدمة البعيدة
 * @param {object} mailbox صفّ الصندوق من قاعدة البيانات
 * @param {{manual?: boolean}} options
 * @returns {Promise<{synced: boolean, added: number, reason?: string}>}
 */
async function syncMailbox(mailbox, { manual = false } = {}) {
  if (!mailbox || mailbox.provider === 'local') return { synced: false, added: 0, reason: 'local' };
  if (!mailbox.token) return { synced: false, added: 0, reason: 'no-token' };

  // تقييد المزامنة اليدوية المتكررة (منع استنزاف الميزانية بضغطات الزر)
  if (manual) {
    const last = lastManualSync.get(mailbox.id) || 0;
    if (Date.now() - last < config.mailtm.manualSyncThrottleMs) {
      return { synced: false, added: 0, reason: 'throttled' };
    }
    lastManualSync.set(mailbox.id, Date.now());
  }

  if (!hasBudget()) {
    return { synced: false, added: 0, reason: 'no-budget' };
  }

  try {
    const provider = providers.mailtm;
    const remoteMessages = await provider.listMessages(mailbox);

    // الأحدث أولاً، ثم نأخذ الجديد غير المخزّن
    const fresh = [];
    for (const msg of remoteMessages) {
      if (!msg.providerId) continue;
      if (db.hasProviderMessage(mailbox.id, msg.providerId)) continue;
      fresh.push(msg);
      if (fresh.length >= MAX_NEW_PER_CYCLE) break;
    }

    let added = 0;
    for (const msg of fresh) {
      // الرسائل التي لا تملك محتوى (نص/HTML) نجلبها كاملة بطلب إضافي
      let full = msg;
      if (!msg.text && !msg.html) {
        if (!hasBudget()) break;
        try {
          full = await provider.getMessage(mailbox, msg.providerId);
        } catch (error) {
          logger.debug(`تعذّر جلب محتوى الرسالة: ${error.message}`);
        }
      }
      storeRemoteMessage(mailbox, full);
      added += 1;

      // تعليم كمقروءة على الخدمة (اختياري — يستهلك طلباً إضافياً)
      if (config.mailtm.markSeen) {
        provider.markSeen(mailbox, full.providerId).catch((e) => logger.debug(`تعذّر تعليم المقروءة: ${e.message}`));
      }
    }

    db.markSynced(mailbox.id, null);
    if (added > 0) logger.debug(`🔄 ${mailbox.address}: ${added} رسالة جديدة`);
    return { synced: true, added };
  } catch (error) {
    db.markSynced(mailbox.id, error.message);
    logger.warn(`مزامنة ${mailbox.address} فشلت: ${error.message}`);
    return { synced: false, added: 0, reason: error.message };
  }
}

/**
 * يحسب الفاصل "التكيّفي" بين المزامنات:
 *   كلما زاد عدد الصناديق النشطة، تباعدت المزامنة تلقائياً
 *   حتى لا نتجاوز ميزانية الطلبات (30/دقيقة لدى الخدمة).
 *
 *   الفاصل = 60 ثانية × عدد الصناديق ÷ ميزانية الدقيقة
 *   مثال: 10 صناديق وميزانية 20 → كل صندوق يُزامن كل 30 ثانية
 */
function adaptiveIntervalMs(activeCount) {
  const base = config.mailtm.pollIntervalMs;
  if (!activeCount) return base;
  const calculated = Math.ceil((60000 * activeCount) / Math.max(1, config.mailtm.ratePerMinute));
  return Math.min(Math.max(base, calculated), 5 * MINUTE); // بين الفاصل الأساسي و5 دقائق
}

/** دورة مزامنة واحدة لكل الصناديق النشطة */
async function syncCycle() {
  if (config.provider === 'local') return;

  const activeSince = Date.now() - config.mailtm.activeWindowMinutes * MINUTE;
  const activeCount = db.countActiveMailboxes('mailtm', activeSince);
  if (!activeCount) return;

  const interval = adaptiveIntervalMs(activeCount);
  const candidates = db.listSyncCandidates('mailtm', activeSince, config.mailtm.maxPerCycle);

  if (!candidates.length) return;

  const now = Date.now();
  let done = 0;

  for (const mailbox of candidates) {
    if (!hasBudget()) break;
    // احترام الفاصل التكيّفي بين المزامنات لنفس الصندوق
    if (mailbox.last_synced_at && now - mailbox.last_synced_at < interval) continue;
    await syncMailbox(mailbox);
    done += 1;
  }

  if (done) {
    logger.debug(`🔁 مزامنة: ${done} صندوق | نشطة: ${activeCount} | فاصل: ${Math.round(interval / 1000)}ث | ميزانية ≈ ${client.limiter.available()}`);
  }
}

function startSyncWorker() {
  if (config.provider === 'local') {
    logger.info('⏭  عامل المزامنة معطّل (المزوّد محلي — الرسائل تصل بالدفع)');
    return null;
  }

  // دورة أولى بعد ثانيتين من الإقلاع
  setTimeout(() => syncCycle().catch((e) => logger.error(e.message)), 2000);

  timer = setInterval(() => {
    syncCycle().catch((error) => logger.error(`خطأ في دورة المزامنة: ${error.message}`));
  }, config.mailtm.pollIntervalMs);

  if (timer.unref) timer.unref();

  logger.info(`🔁 عامل المزامنة: كل ${config.mailtm.pollIntervalMs / 1000} ثانية · ${config.mailtm.maxPerCycle} صناديق/دورة · ${config.mailtm.ratePerMinute} طلب/دقيقة`);
  return timer;
}

function stopSyncWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { startSyncWorker, stopSyncWorker, syncCycle, syncMailbox, storeRemoteMessage };
