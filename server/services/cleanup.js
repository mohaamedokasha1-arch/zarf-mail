/**
 * =============================================================
 *  عامل التنظيف الدوري (Cleanup Job) — ظرف
 * -------------------------------------------------------------
 *  يحذف تلقائياً:
 *    - كل رسالة مضى عليها MESSAGE_TTL_MINUTES (افتراضياً ساعة)
 *    - كل صندوق بريد مضى عليه MAILBOX_TTL_MINUTES
 *  وإن كان المزوّد mail.tm، يحذف أيضاً النسخة البعيدة:
 *    DELETE /messages/{id}  ثم  DELETE /accounts/{id}
 *  (ضمن ميزانية الطلبات المتاحة — وبطريقة لا تعطّل التنظيف المحلي)
 *
 *  هذه أهم طبقة لحماية خصوصية المستخدم: لا شيء يبقى للأبد.
 * =============================================================
 */

const db = require('../db');
const config = require('../config');
const logger = require('../lib/logger');
const providers = require('../providers');
const { client } = require('../providers/http-client');

let timer = null;

/** هل لدينا ميزانية طلبات للخدمة البعيدة؟ */
function hasBudget() {
  return client.limiter.available() >= 1;
}

/**
 * يحذف النسخ البعيدة للرسائل والحسابات المنتهية (best effort)
 */
async function purgeRemote() {
  if (config.provider === 'local' || !config.mailtm.deleteOnExpire) return { messages: 0, accounts: 0 };

  let deletedMessages = 0;
  let deletedAccounts = 0;

  // 1) الرسائل المنتهية
  const expiredMessages = db.listExpiredMessages(40);
  for (const row of expiredMessages) {
    if (!hasBudget()) break;
    const mailbox = { id: row.mailbox_id, token: row.token, provider_id: row.account_id, address: row.id };
    try {
      if (row.provider_id && row.token) {
        await providers.mailtm.deleteMessage(mailbox, row.provider_id);
        deletedMessages += 1;
      }
    } catch (e) { /* تجاهل */ }
  }

  // 2) الحسابات المنتهية
  const expiredMailboxes = db.listExpiredMailboxes(20);
  for (const row of expiredMailboxes) {
    if (!hasBudget()) break;
    try {
      const ok = await providers.mailtm.deleteMailbox(row);
      if (ok) deletedAccounts += 1;
    } catch (e) { /* تجاهل */ }
  }

  if (deletedMessages || deletedAccounts) {
    logger.info(`☁️  حذف من mail.tm: ${deletedMessages} رسالة و ${deletedAccounts} حساب منتهي`);
  }
  return { messages: deletedMessages, accounts: deletedAccounts };
}

async function runCleanup() {
  const report = { localMessages: 0, localMailboxes: 0, remoteMessages: 0, remoteAccounts: 0 };

  try {
    // نحذف من الخدمة البعيدة أولاً (قبل فقدان البيانات المحلية!)
    const remote = await purgeRemote();
    report.remoteMessages = remote.messages;
    report.remoteAccounts = remote.accounts;
  } catch (error) {
    logger.error('فشل الحذف من الخدمة البعيدة:', error.message);
  }

  try {
    const { messages, mailboxes } = db.pruneExpired();
    report.localMessages = messages;
    report.localMailboxes = mailboxes;
    if (messages || mailboxes) {
      logger.info(`🧹 تنظيف: حُذفت ${messages} رسالة و ${mailboxes} صندوق بريد منتهي الصلاحية`);
    }
  } catch (error) {
    logger.error('فشل التنظيف الدوري:', error.message);
  }

  return report;
}

function startCleanupJob() {
  const intervalMs = Math.max(1, config.cleanupIntervalMinutes) * 60 * 1000;

  // تنظيف أولي عند الإقلاع (بعد 3 ثوانٍ حتى تكتمل الإقلاعات الأخرى)
  setTimeout(() => runCleanup(), 3000);

  timer = setInterval(runCleanup, intervalMs);
  if (timer.unref) timer.unref();

  logger.info(`⏱  عامل التنظيف يعمل كل ${config.cleanupIntervalMinutes} دقيقة — يحذف ما تجاوز ${config.mailboxTtlMinutes / 1440} يوم فقط`);
  return timer;
}

function stopCleanupJob() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { startCleanupJob, stopCleanupJob, runCleanup, purgeRemote };
