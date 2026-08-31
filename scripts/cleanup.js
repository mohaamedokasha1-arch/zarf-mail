#!/usr/bin/env node
/**
 * =============================================================
 *  سكربت التنظيف المستقل (Cron Job) — ظرف (Zarf Mail)
 * -------------------------------------------------------------
 *  يحذف:
 *    • الرسائل التي مضى على إنشائها أكثر من MESSAGE_TTL_MINUTES (7 أيام)
 *    • صناديق البريد التي مضى على إنشائها أكثر من MAILBOX_TTL_MINUTES (7 أيام)
 *  ومع مزوّد mail.tm يحذف النسخة البعيدة أيضاً
 *  (DELETE /messages/{id} و DELETE /accounts/{id}) ضمن ميزانية الطلبات.
 *
 *  التشغيل اليدوي:
 *      node scripts/cleanup.js
 *
 *  تشغيل تلقائي كل ساعة عبر Cron (Linux/macOS):
 *      crontab -e
 *      0 * * * * cd /path/to/zarf-mail && /usr/bin/node scripts/cleanup.js >> /var/log/zarf-cleanup.log 2>&1
 *
 *  أو كل يوم في الثالثة فجراً:
 *      0 3 * * * cd /path/to/zarf-mail && /usr/bin/node scripts/cleanup.js >> /var/log/zarf-cleanup.log 2>&1
 *
 *  على Windows: استخدم "Task Scheduler" بتكرار ساعة ونفس الأمر.
 *
 *  ملاحظة: السيرفر نفسه يشغّل عاملاً داخلياً كل CLEANUP_INTERVAL_MINUTES دقيقة،
 *  وهذا السكربت مفيد كطبقة إضافية (أو عند تشغيل عدة نسخ من التطبيق).
 * =============================================================
 */

const config = require('../server/config');
const db = require('../server/db');
const logger = require('../server/lib/logger');
const { runCleanup } = require('../server/services/cleanup');

const startedAt = Date.now();

(async () => {
  logger.info('🧹 بدء مهمة التنظيف (Cron)…');
  logger.info(`   · مدة صلاحية البريد : ${config.mailboxTtlMinutes} دقيقة (${config.mailboxTtlMinutes / 1440} يوم)`);
  logger.info(`   · مدة صلاحية الرسالة: ${config.messageTtlMinutes} دقيقة (${config.messageTtlMinutes / 1440} يوم)`);

  // إحصائيات قبل التنظيف
  const before = db.stats();

  const report = await runCleanup();

  const after = db.stats();

  logger.info('📊 تقرير التنظيف:');
  logger.info(`   · محلياً  : ${report.localMessages} رسالة و ${report.localMailboxes} صندوق`);
  logger.info(`   · بعيداً  : ${report.remoteMessages} رسالة و ${report.remoteAccounts} حساب (mail.tm)`);
  logger.info(`   · الصناديق: ${before.mailboxes} → ${after.mailboxes}`);
  logger.info(`   · الرسائل : ${before.messages} → ${after.messages}`);
  logger.success(`✅ اكتمل التنظيف في ${Date.now() - startedAt} ملّي ثانية`);

  process.exit(0);
})().catch((error) => {
  logger.error(`فشل التنظيف: ${error.message}`);
  process.exit(1);
});
