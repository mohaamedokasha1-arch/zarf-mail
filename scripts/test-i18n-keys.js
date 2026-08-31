#!/usr/bin/env node
/**
 * =============================================================
 *  فاحص سلامة قواميس اللغات (i18n) — ظرف
 * -------------------------------------------------------------
 *  يتحقق من:
 *    1) أن كل لغة تملك نفس عدد المفاتيح تماماً (لا مفتاح ناقص/زائد)
 *    2) أن كل مفتاح مستخدم في index.html أو app.js موجود في القواميس
 *    3) عدم وجود قيم فارغة أو غير مترجمة
 *    4) صحة بيانات اللغات (رمز · علم · اتجاه)
 *    5) وجود مفاتيح صيغ الجمع المطلوبة لكل لغة
 *    6) أن المتغيّرات {name} متطابقة بين اللغات
 *
 *  التشغيل:  node scripts/test-i18n-keys.js
 * =============================================================
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const I18N = path.join(ROOT, 'public/assets/js/i18n.js');
const HTML = path.join(ROOT, 'public/index.html');
const APP = path.join(ROOT, 'public/assets/js/app.js');
const BOOT = path.join(ROOT, 'public/assets/js/boot.js');

let pass = 0;
let fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ' — ' + extra : ''}`); }
};

// تحميل المحرك في بيئة Node (يحمي نفسه من غياب document/localStorage)
const I18n = require(I18N);
I18n.init();

const CODES = I18n.LANGS.map((l) => l.code);
const DICT = I18n.DICT;
const BASE = DICT.ar;
const BASE_KEYS = Object.keys(BASE);

console.log('\n1) اكتمال القواميس');
console.log(`   · اللغات: ${CODES.length} · المفاتيح لكل لغة: ${BASE_KEYS.length}`);
CODES.forEach((code) => {
  const keys = Object.keys(DICT[code] || {});
  const missing = BASE_KEYS.filter((k) => !(k in (DICT[code] || {})));
  const extra = keys.filter((k) => !(k in BASE));
  ok(missing.length === 0 && extra.length === 0, `${code}: نفس مجموعة المفاتيح`,
    missing.length ? `ناقص: ${missing.slice(0, 4).join(', ')}` : extra.length ? `زائد: ${extra.slice(0, 4).join(', ')}` : `${keys.length} مفتاح`);
});

console.log('\n2) خلوّ القيم من الفراغ');
let empties = [];
CODES.forEach((code) => {
  BASE_KEYS.forEach((k) => {
    const v = (DICT[code] || {})[k];
    if (typeof v !== 'string' || v.trim() === '') empties.push(`${code}.${k}`);
  });
});
ok(empties.length === 0, 'لا قيم فارغة', empties.slice(0, 5).join(', '));

console.log('\n3) المفاتيح المستخدمة في الواجهة موجودة في القواميس');
const html = fs.readFileSync(HTML, 'utf8');
const app = fs.readFileSync(APP, 'utf8');
const used = new Set();
for (const m of html.matchAll(/data-i18n(?:-html|-placeholder|-title-doc|-title|-aria)?="([^"]+)"/g)) used.add(m[1]);
for (const m of app.matchAll(/\bt\('([a-zA-Z.]+)'/g)) used.add(m[1]);
used.add('meta.desc'); // يُستخدم برمجياً داخل applyDocument

// مفاتيح الجمع: tCount('inbox.count', n) → inbox.count_one / _other / …
const pluralBases = new Set();
for (const m of app.matchAll(/\btCount\('([a-zA-Z.]+)'/g)) pluralBases.add(m[1]);

const notFound = [...used].filter((k) => BASE[k] === undefined);
ok(notFound.length === 0, `كل المفاتيح المستخدمة (${used.size}) موجودة`, notFound.join(', '));

[...pluralBases].forEach((base) => {
  const missing = CODES.filter((code) => (DICT[code] || {})[`${base}_other`] === undefined);
  ok(missing.length === 0, `صيغة الجمع ${base}_* متوفرة لكل لغة`, missing.join(', '));
});

console.log('\n4) بيانات اللغات');
ok(I18n.LANGS.every((l) => l.code && l.native && l.english && l.flag && l.dir), 'كل لغة لها رمز واسم وعلم واتجاه');
ok(I18n.LANGS.filter((l) => l.dir === 'rtl').map((l) => l.code).join(',') === 'ar,fa,ur,he',
  'لغات RTL هي ar و fa و ur و he');
ok(new Set(I18n.LANGS.map((l) => l.code)).size === I18n.LANGS.length, 'لا رموز مكرّرة');

// boot.js يجب أن يعرف نفس اللغات
const boot = fs.readFileSync(BOOT, 'utf8');
const bootLangs = (boot.match(/var LANGS = \[([^\]]+)\]/) || [])[1];
const bootCodes = bootLangs ? bootLangs.match(/'[a-z]{2}'/g).map((x) => x.replace(/'/g, '')) : [];
ok(CODES.every((c) => bootCodes.includes(c)), 'boot.js يعرف نفس قائمة اللغات', bootCodes.join(','));
const bootRtl = (boot.match(/var RTL = \{([^}]+)\}/) || [])[1] || '';
ok(I18n.LANGS.filter((l) => l.dir === 'rtl').every((l) => bootRtl.includes(`${l.code}: true`)),
  'boot.js يطابق لغات RTL');

console.log('\n5) صيغ الجمع');
const plural = {
  ar: ['zero', 'one', 'two', 'few', 'many', 'other'],
  ru: ['one', 'few', 'many', 'other'],
  pl: ['one', 'few', 'many', 'other'],
  he: ['one', 'two', 'other'],
  default: ['one', 'other'],
};
CODES.forEach((code) => {
  const needed = plural[code] || plural.default;
  const missing = needed.filter((s) => BASE[`inbox.count_${s}`] === undefined || (DICT[code] || {})[`inbox.count_${s}`] === undefined);
  ok(missing.length === 0, `${code}: صيغ الجمع (${needed.join('/')})`, missing.join(', '));
});

console.log('\n6) تطابق المتغيّرات {name} بين اللغات');
const varsOf = (str) => (str.match(/\{(\w+)\}/g) || []).sort().join(',');
let varMismatch = [];
CODES.forEach((code) => {
  BASE_KEYS.forEach((k) => {
    if (varsOf(BASE[k]) !== varsOf(String((DICT[code] || {})[k] ?? ''))) varMismatch.push(`${code}.${k}`);
  });
});
ok(varMismatch.length === 0, 'المتغيّرات متطابقة في كل اللغات', varMismatch.slice(0, 5).join(', '));

console.log('\n7) الترجمة الفعلية تعمل');
I18n.setLocale('en');
ok(I18n.t('inbox.title') === 'Inbox', 'الإنجليزية: Inbox', I18n.t('inbox.title'));
I18n.setLocale('ar');
ok(I18n.t('inbox.title') === 'صندوق الوارد', 'العربية: صندوق الوارد', I18n.t('inbox.title'));
ok(I18n.t('ttl.validFor', { days: 7 }).includes('7'), 'المتغيّرات تُستبدل', I18n.t('ttl.validFor', { days: 7 }));

console.log(`\n═══════════════════════════════════════════\n   نتيجة فحص القواميس: ${pass} ناجح · ${fail} فاشل\n═══════════════════════════════════════════\n`);
process.exit(fail ? 1 : 0);
