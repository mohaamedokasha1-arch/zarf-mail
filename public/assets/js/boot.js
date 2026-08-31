/**
 * =============================================================
 *  الإقلاع المبكر (boot) — ظرف
 * -------------------------------------------------------------
 *  يُحمَّل في <head> قبل رسم الجسم، ومهمّته الوحيدة:
 *  ضبط lang و dir من اللغة المحفوظة/لغة المتصفح قبل أول رسم،
 *  حتى لا يرى المستخدم وميضاً بالاتجاه الخطأ (FOUC/FOIT).
 *
 *  لا يعتمد على أي ملف آخر، ولا يلمس DOM غير <html>.
 *  (سياسة CSP تمنع السكربتات المضمّنة، لذلك هذا ملف خارجي.)
 * =============================================================
 */
(function () {
  'use strict';

  // اللغات المدعومة (يجب أن تطابق LANGS في i18n.js)
  var LANGS = [
    'ar', 'fa', 'ur', 'he', 'en', 'fr', 'es', 'de', 'it', 'pt',
    'nl', 'pl', 'tr', 'ru', 'zh', 'ja', 'ko', 'hi', 'id', 'vi',
  ];
  var RTL = { ar: true, fa: true, ur: true, he: true };

  function pick() {
    try {
      var saved = localStorage.getItem('zarf:locale');
      if (saved && LANGS.indexOf(saved) > -1) return saved;
    } catch (e) { /* الوضع الخاص (Private Mode) */ }

    try {
      var nav = (navigator.languages && navigator.languages.length)
        ? navigator.languages
        : [navigator.language || navigator.userLanguage || 'ar'];
      for (var i = 0; i < nav.length; i++) {
        var short = String(nav[i] || '').toLowerCase().split('-')[0];
        if (LANGS.indexOf(short) > -1) return short;
      }
    } catch (e) { /* تجاهل */ }

    return 'ar';
  }

  var code = pick();
  var html = document.documentElement;
  html.setAttribute('lang', code);
  html.setAttribute('dir', RTL[code] ? 'rtl' : 'ltr');

  // الوضع الليلي مبكراً كذلك (يمنع وميض الخلفية البيضاء)
  try {
    var theme = localStorage.getItem('zarf:theme');
    if (theme === 'light') html.classList.add('light');
    else html.classList.remove('light');
  } catch (e) { /* تجاهل */ }
})();
