/**
 * =============================================================
 *  مصنع المزوّدات (Provider Factory) — ظرف
 * -------------------------------------------------------------
 *  يختار مزوّد البريد حسب المتغير MAIL_PROVIDER:
 *     mailtm : خدمة mail.tm (الأساسي — دومينات حقيقية)
 *     local  : استقبال محلي عبر SMTP / Webhook
 *     hybrid : الاثنان (mail.tm للبريد الحقيقي + محلي للتجارب)
 * =============================================================
 */

const config = require('../config');
const logger = require('../lib/logger');

const mailtm = require('./mailtm.provider');
const local = require('./local.provider');

/** المزوّد المسؤول عن إنشاء العناوين الجديدة */
function primary() {
  return config.provider === 'local' ? local : mailtm;
}

/** هل المزوّد المحلي مفعّل (لاستقبال SMTP/Webhook)؟ */
function localEnabled() {
  return config.provider === 'local' || config.provider === 'hybrid';
}

function describeAll() {
  return {
    active: config.provider,
    primary: primary().name,
    localEnabled: localEnabled(),
    providers: [mailtm.describe(), local.describe()],
  };
}

logger.info(`🔌 مزوّد البريد الأساسي: ${primary().name.toUpperCase()} (MAIL_PROVIDER=${config.provider})`);

module.exports = {
  primary,
  localEnabled,
  describeAll,
  mailtm,
  local,
};
