/**
 * =============================================================
 *  سيرفر SMTP لاستقبال الرسائل — ظرف (Zarf Mail)
 * -------------------------------------------------------------
 *  هذا سيرفر SMTP حقيقي (بناءً على smtp-server) يستقبل الرسائل
 *  مباشرة حين توجه سجلّات MX للدومين إلى هذا السيرفر.
 *
 *  ملاحظة مهمة للإنتاج:
 *    - البورت القياسي لاستقبال البريد هو 25، وتحتاج صلاحيات root لتشغيله.
 *    - كثير من الاستضافات المجانية (Render/Railway/Vercel) تحجب البورت 25،
 *      ولذلك الحل الأسهل والمجاني هو Cloudflare Email Routing + Worker
 *      (راجع ملف cloudflare-worker/worker.js وشرح README).
 *    - للتجربة المحلية: البورت الافتراضي هنا 2525 (لا يحتاج صلاحيات).
 * =============================================================
 */

const { SMTPServer } = require('smtp-server');
const config = require('../config');
const logger = require('../lib/logger');
const { ingestRawEmail } = require('../services/mailbox');

/**
 * يُشغّل سيرفر SMTP
 * @returns {SMTPServer|null}
 */
function startSmtpServer() {
  if (!config.smtp.enabled) {
    logger.warn('سيرفر SMTP معطّل من الإعدادات (SMTP_ENABLED=false)');
    return null;
  }
  // لا نشغّل الاستقبال المحلي إلا إذا كان المزوّد المحلي مفعّلاً (local أو hybrid)
  // eslint-disable-next-line global-require
  const providers = require('../providers');
  if (!providers.localEnabled()) {
    logger.info('⏭  سيرفر SMTP المحلي غير مفعّل (المزوّد الأساسي الخارجي يكفي) — فعّله بـ MAIL_PROVIDER=hybrid إن أردته');
    return null;
  }

  const server = new SMTPServer({
    // الاستقبال لا يحتاج مصادقة (نحن نستقبل من كل العالم)
    authOptional: true,
    disabledCommands: ['AUTH'],
    banner: config.smtp.banner,
    size: config.maxMessageSize,   // أقصى حجم للرسالة
    secure: false,
    logger: false,
    hideSTARTTLS: true,
    hidePIPELINING: true,
    socketTimeout: 30 * 1000,
    closeTimeout: 10 * 1000,

    /**
     * فحص المستلم: نقبل فقط العناوين على دوميناتنا
     */
    onRcptTo(address, session, callback) {
      const domain = String(address.address || '').split('@')[1]?.toLowerCase();
      if (!config.domains.includes(domain)) {
        logger.warn(`مرفوض: مستلم خارج دومينات ظرف → ${address.address}`);
        return callback(new Error('550 هذا السيرفر يستقبل فقط عناوين ظرف'));
      }
      return callback();
    },

    /**
     * استلام بيانات الرسالة
     */
    onData(stream, session, callback) {
      const chunks = [];
      let size = 0;
      let tooBig = false;

      stream.on('data', (chunk) => {
        size += chunk.length;
        if (size > config.maxMessageSize) {
          tooBig = true;
          stream.destroy();          // نوقف الاستلام فوراً لحماية الذاكرة
          return;
        }
        chunks.push(chunk);
      });

      stream.on('end', async () => {
        if (tooBig) {
          return callback(new Error('552 حجم الرسالة يتجاوز الحد المسموح'));
        }

        const raw = Buffer.concat(chunks);

        try {
          // نجمع كل المستلمين في الجلسة ونسلّم الرسالة لكل منهم
          const recipients = (session.envelope?.rcptTo || [])
            .map((r) => String(r.address || '').toLowerCase())
            .filter(Boolean);

          const targets = recipients.length ? recipients : [null];

          for (const recipient of targets) {
            const result = recipient
              ? await ingestRawEmail(injectRecipient(raw, recipient))
              : await ingestRawEmail(raw);
            if (!result.ok) logger.warn(`تعذّر تخزين الرسالة: ${result.reason}`);
          }

          return callback(null, '250 تم قبول الرسالة في ظرف ✅');
        } catch (error) {
          logger.error('خطأ أثناء معالجة الرسالة:', error.message);
          return callback(new Error('451 خطأ مؤقت في الخادم'));
        }
      });

      stream.on('error', (error) => {
        logger.error('خطأ في تدفق SMTP:', error.message);
        callback(new Error('451 خطأ في استلام البيانات'));
      });
    },

    onError(error) {
      logger.error(`خطأ SMTP: ${error.message}`);
    },
  });

  server.on('error', (error) => {
    // خطأ شائع: محاولة تشغيل البورت 25 بدون صلاحيات
    if (error.code === 'EACCES') {
      logger.error(`لا تملك صلاحية تشغيل البورت ${config.smtp.port} — استخدم بورتاً أعلى من 1024 أو شغّل بصلاحيات root`);
    } else {
      logger.error(`سيرفر SMTP: ${error.message}`);
    }
  });

  server.listen(config.smtp.port, config.smtp.host, () => {
    logger.success(`📬 سيرفر SMTP يستمع على ${config.smtp.host}:${config.smtp.port}`);
  });

  return server;
}

/**
 * يضمن أن عنوان المستلم الصحيح موجود في ترويسات الرسالة
 * (بعض السيرفرات ترسل الرسالة بدون ترويسة To عندما يكون هناك أكثر من مستلم)
 */
function injectRecipient(raw, recipient) {
  const headerEnd = raw.indexOf('\r\n\r\n');
  if (headerEnd === -1) return raw;

  const headers = raw.slice(0, headerEnd).toString('utf8');
  const body = raw.slice(headerEnd);

  if (/^to:/im.test(headers)) return raw;

  return Buffer.concat([
    Buffer.from(`${headers}\r\nTo: ${recipient}`, 'utf8'),
    body,
  ]);
}

module.exports = { startSmtpServer };
