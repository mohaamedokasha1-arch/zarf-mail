/**
 * =============================================================
 *  مسجّل الأحداث (Logger) — ظرف
 * -------------------------------------------------------------
 *  مسجّل بسيط وسريع مع ألوان في الطرفية ومستويات:
 *  info / warn / error / debug / success
 * =============================================================
 */

const config = require('../config');

const COLORS = {
  reset: '\x1b[0m',
  gray: '\x1b[90m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

/** الوقت الحالي بصيغة قصيرة */
function timestamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function write(level, color, args) {
  const tag = `${COLORS.gray}[${timestamp()}]${COLORS.reset} ${color}${level}${COLORS.reset}`;
  // لا نستخدم console.log مباشرة حتى نضمن الترتيب
  process.stdout.write(`${tag} ${args.join(' ')}\n`);
}

const logger = {
  info: (...args) => write('INFO   ', COLORS.cyan, args),
  success: (...args) => write('OK     ', COLORS.green, args),
  warn: (...args) => write('WARN   ', COLORS.yellow, args),
  error: (...args) => write('ERROR  ', COLORS.red, args),
  mail: (...args) => write('MAIL   ', COLORS.magenta, args),
  debug: (...args) => {
    if (!config.isProd) write('DEBUG  ', COLORS.blue, args);
  },
};

module.exports = logger;
