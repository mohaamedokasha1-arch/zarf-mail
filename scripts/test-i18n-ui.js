/**
 * =============================================================
 *  اختبار واجهة ظرف (UI) — بيئة jsdom
 * -------------------------------------------------------------
 *  يفحص:
 *    1) التهيئة الأولية لمحرك اللغات (lang/dir/عنوان الصفحة)
 *    2) إنشاء بريد حقيقي + العدّاد التنازلي (7 أيام)
 *    3) تبديل اللغة فوراً بدون إعادة تحميل (قائمة منسدلة)
 *    4) اتجاه RTL/LTR للعربية والفارسية وبقية اللغات + صيغ الجمع
 *    5) دورة رسالة حقيقية: وصول → استخراج OTP → مودال → تغيير لغة داخله
 *    6) خلوّ الصفحة من أخطاء الجافاسكربت
 *
 *  التشغيل (السيرفر يجب أن يعمل على 3000):
 *      npm run test:ui
 * =============================================================
 */
const fs = require('fs');
const { JSDOM, VirtualConsole } = require('jsdom');

const BASE = 'http://127.0.0.1:3000';
const errors = [];
let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ' — ' + extra : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push('jsdomError: ' + (e.stack || e.message).toString().slice(0, 200)));
  vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ').slice(0, 200)));

  const html = fs.readFileSync('/home/user/zarf-mail/public/index.html', 'utf8');
  const nodeFetch = globalThis.fetch;

  const dom = new JSDOM(html, {
    url: BASE + '/',
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) {
      // jsdom لا يوفّر fetch → نربطه بـ fetch الخاص بـ Node مع تحويل المسارات النسبية
      window.fetch = (url, opts) => nodeFetch(new URL(String(url), BASE).toString(), opts);
      window.Headers = globalThis.Headers;
      window.Request = globalThis.Request;
      window.Response = globalThis.Response;
      window.EventSource = undefined; // نتجاهل SSE في الاختبار (التحديث الدوري يكفي)
      // نفرض العربية كلغة محفوظة لاختبار الوضع الافتراضي
      try { window.localStorage.setItem('zarf:locale', 'ar'); } catch (e) { /* */ }
    },
  });

  const { window } = dom;
  const doc = window.document;
  const $ = (s) => doc.querySelector(s);
  const txt = (s) => ($(s) ? $(s).textContent.trim() : '<missing>');
  const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const langOpen = () => !$('#langMenu').classList.contains('hidden');
  const wait = async (fn, timeout = 30000, label = '') => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try { if (fn()) return true; } catch (e) { /* */ }
      await sleep(150);
    }
    if (label) console.log('   ⏱️  timeout: ' + label);
    return false;
  };

  await sleep(1500);

  console.log('\n📋 1) التهيئة الأولية واللغة الافتراضية');
  ok(!!window.ZarfI18n, 'محرك اللغات محمّل (window.ZarfI18n)');
  ok(doc.documentElement.lang === 'ar', 'lang="ar"', doc.documentElement.lang);
  ok(doc.documentElement.dir === 'rtl', 'dir="rtl" للعربية', doc.documentElement.dir);
  ok(/ظرف/.test(doc.title), 'عنوان الصفحة مترجم بالعربية', doc.title);
  ok(/صندوق الوارد/.test(txt('h2[data-i18n="inbox.title"]')), 'عنوان صندوق الوارد بالعربية',
     txt('h2[data-i18n="inbox.title"]'));
  ok($('#searchInput').placeholder.includes('ابحث'), 'placeholder البحث بالعربية', $('#searchInput').placeholder);
  ok($('#langMenu').children.length === 20, 'قائمة اللغات مبنية (20 لغة)', String($('#langMenu').children.length));
  ok(txt('#langCurrent') === 'العربية', 'اسم اللغة على الزر', txt('#langCurrent'));

  console.log('\n📋 2) إنشاء بريد حقيقي + العدّاد التنازلي (7 أيام)');
  await wait(() => /@/.test($('#emailText').textContent), 45000, 'ظهور العنوان');
  const addr = $('#emailText').textContent.trim();
  ok(/^[\w.+-]+@[\w.-]+$/.test(addr), 'تم توليد عنوان بريد حقيقي', addr);
  ok(!$('#providerBadge').classList.contains('hidden'), 'شارة المزوّد ظاهرة', txt('#providerBadge'));

  await sleep(1500);
  const cd = txt('#countdownText');
  ok(/^\d+[^0-9]? \d\d:\d\d:\d\d$|^\d+d \d\d:\d\d:\d\d$/.test(cd), 'العدّاد: أيام:ساعات:دقائق:ثواني', cd);
  const days = parseInt(cd, 10);
  ok(days >= 6 && days <= 7, 'عدد الأيام ≈ 7', String(days));
  ok(/7/.test(txt('#ttlNote')), 'ملاحظة «صالح 7 أيام»', txt('#ttlNote'));
  ok(/7/.test(txt('#footerTtl')), 'التذييل يذكر 7 أيام', txt('#footerTtl'));

  console.log('\n📋 3) تبديل اللغة فوراً بدون إعادة تحميل');
  click($('#langBtn'));
  ok(!$('#langMenu').classList.contains('hidden'), 'القائمة تُفتح عند الضغط');
  ok($('#langBtn').getAttribute('aria-expanded') === 'true', 'aria-expanded=true');
  ok(!!$('#langMenu').querySelector('[data-lang="en"]'), 'خيار الإنجليزية موجود');

  click($('#langMenu').querySelector('[data-lang="en"]'));
  ok(doc.documentElement.dir === 'ltr', 'dir انقلب إلى ltr', doc.documentElement.dir);
  ok(doc.documentElement.lang === 'en', 'lang انقلب إلى en', doc.documentElement.lang);
  ok($('#langMenu').classList.contains('hidden'), 'القائمة تُغلق بعد الاختيار');
  ok(/Inbox/i.test(txt('h2[data-i18n="inbox.title"]')), 'العنوان صار Inbox', txt('h2[data-i18n="inbox.title"]'));
  ok(/search/i.test($('#searchInput').placeholder), 'placeholder البحث إنجليزي', $('#searchInput').placeholder);
  ok($('#emailText').textContent.trim() === addr, 'عنوان البريد لم يتأثر بتبديل اللغة', addr);
  ok(/Valid for 7 days/i.test(txt('#ttlNote')), 'ملاحظة الـ TTL إنجليزية', txt('#ttlNote'));
  ok(/New email/i.test(doc.body.textContent), "نص زر «بريد جديد» مترجم (New email)");
  ok(window.localStorage.getItem('zarf:locale') === 'en', 'اللغة محفوظة', window.localStorage.getItem('zarf:locale'));
  ok(txt('#langCurrent') === 'English', 'اسم اللغة على الزر تحدّث', txt('#langCurrent'));

  console.log('\n📋 4) لغات أخرى: فارسية (RTL)، فرنسية وروسية (LTR)، صيغ الجمع');
  const pick = (code) => { click($('#langBtn')); click($('#langMenu').querySelector(`[data-lang="${code}"]`)); };
  pick('fa');
  ok(doc.documentElement.dir === 'rtl' && doc.documentElement.lang === 'fa', 'الفارسية → dir=rtl', doc.documentElement.dir);
  pick('fr');
  ok(doc.documentElement.dir === 'ltr' && doc.documentElement.lang === 'fr', 'الفرنسية → dir=ltr', doc.documentElement.dir);
  ok(/Boîte de réception/i.test(txt('h2[data-i18n="inbox.title"]')), 'العنوان بالفرنسية', txt('h2[data-i18n="inbox.title"]'));
  pick('ru');
  ok(doc.documentElement.dir === 'ltr', 'الروسية → dir=ltr');
  pick('ar');
  ok(doc.documentElement.dir === 'rtl', 'العودة للعربية → dir=rtl');
  ok(txt('#messagesCount') === 'لا رسائل', 'صيغة الجمع العربي (صفر)', txt('#messagesCount'));

  console.log('\n📋 5) رسالة حقيقية + استخراج OTP + المودال');
  click($('#demoBtn'));
  await wait(() => doc.querySelectorAll('#messagesList [data-message-id]').length > 0, 90000, 'وصول رسالة');
  const rows = doc.querySelectorAll('#messagesList [data-message-id]');
  ok(rows.length > 0, 'وصلت رسالة حقيقية إلى البريد', `${rows.length} رسالة`);
  ok(/رسالة|رسائل/.test(txt('#messagesCount')), 'العدّاد بالعربية', txt('#messagesCount'));
  ok(!$('#otpStrip').classList.contains('hidden'), 'شريط OTP ظاهر');
  ok(/^\d{4,8}$/.test(txt('#otpStripCode')), 'كود OTP مستخرج', txt('#otpStripCode'));

  click(rows[0]);
  await wait(() => !$('#messageModal').classList.contains('hidden'), 20000, 'فتح المودال');
  ok(!$('#messageModal').classList.contains('hidden'), 'المودال مفتوح');
  ok(txt('#modalSenderName').length > 1, 'اسم المرسل ظاهر', txt('#modalSenderName'));
  ok(txt('#modalSubject').length > 1, 'الموضوع ظاهر', txt('#modalSubject').slice(0, 45));
  const srcdoc = $('#mailHtmlFrame').getAttribute('srcdoc') || '';
  ok(srcdoc.includes('dir="rtl"'), 'إطار HTML يتبع اتجاه الواجهة (rtl)');

  pick('en');
  ok(/Close/i.test(txt('#modalDismiss')), 'زر الإغلاق صار Close', txt('#modalDismiss'));
  ok(/[Aa]ttachment|[Nn]o HTML|HTML/.test(doc.body.textContent), 'نصوص المودال مترجمة');
  const srcdoc2 = $('#mailHtmlFrame').getAttribute('srcdoc') || '';
  ok(srcdoc2.includes('dir="ltr"'), 'إطار HTML انقلب إلى ltr مع اللغة');
  click($('#modalDismiss'));
  ok($('#messageModal').classList.contains('hidden'), 'المودال أُغلق');

  pick('ar');
  console.log('\n📋 6) boot.js: اللغة والاتجاه قبل أول رسم (بدون وميض)');
  {
    const boot = fs.readFileSync('/home/user/zarf-mail/public/assets/js/boot.js', 'utf8');
    const probe = new JSDOM('<!doctype html><html lang="ar" dir="rtl"><head></head><body></body></html>',
      { url: BASE + '/', runScripts: 'outside-only' });
    const pw = probe.window;

    pw.localStorage.setItem('zarf:locale', 'fr');
    pw.eval(boot);
    ok(pw.document.documentElement.lang === 'fr' && pw.document.documentElement.dir === 'ltr',
      'لغة محفوظة fr → ltr قبل أي رسم', `${pw.document.documentElement.lang}/${pw.document.documentElement.dir}`);

    const probe2 = new JSDOM('<!doctype html><html lang="ar" dir="rtl"><head></head><body></body></html>',
      { url: BASE + '/', runScripts: 'outside-only' });
    probe2.window.localStorage.setItem('zarf:locale', 'fa');
    probe2.window.localStorage.setItem('zarf:theme', 'light');
    probe2.window.eval(boot);
    ok(probe2.window.document.documentElement.dir === 'rtl', 'الفارسية → rtl',
      probe2.window.document.documentElement.dir);
    ok(probe2.window.document.documentElement.classList.contains('light'),
      'الوضع الليلي/النهاري يُطبَّق مبكراً');

    // بلا قيمة محفوظة → تُكتشف لغة المتصفح (نفرض de-DE داخل jsdom)
    const probe3 = new JSDOM('<!doctype html><html lang="ar" dir="rtl"><head></head><body></body></html>', {
      url: BASE + '/',
      runScripts: 'outside-only',
      beforeParse(w) {
        Object.defineProperty(w.navigator, 'language', { value: 'de-DE', configurable: true });
        Object.defineProperty(w.navigator, 'languages', { value: ['de-DE', 'en'], configurable: true });
      },
    });
    probe3.window.eval(boot);
    ok(probe3.window.document.documentElement.lang === 'de', 'بلا قيمة محفوظة → لغة المتصفح (de)',
      probe3.window.document.documentElement.lang);
    ok(probe3.window.document.documentElement.dir === 'ltr', 'de → ltr');
    ok(!!$('head script[src="assets/js/boot.js"]'), 'boot.js مضمّن في <head>');
  }

  console.log('\n📋 7) قائمة اللغات بلوحة المفاتيح (↑ ↓ Esc)');
  {
    const btn = $('#langBtn');
    btn.focus();
    btn.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    ok(langOpen(), 'ArrowDown يفتح القائمة');
    const items = Array.from($('#langMenu').querySelectorAll('[data-lang]'));
    ok(items.length === 20 && doc.activeElement === items.find((b) => b.getAttribute('aria-selected') === 'true'),
      'المؤشر ينتقل إلى اللغة المختارة');

    doc.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    ok(items.indexOf(doc.activeElement) === 1, '↓ ينقل المؤشر للخيار التالي',
      doc.activeElement && doc.activeElement.dataset.lang);

    doc.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    ok(doc.activeElement === items[items.length - 1], 'End ينتقل لآخر خيار',
      doc.activeElement && doc.activeElement.dataset.lang);

    doc.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    ok(!langOpen(), 'Esc يغلق القائمة');
    ok(doc.activeElement === btn, 'المؤشر يعود إلى الزر');

    btn.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    ok(langOpen(), 'Enter يفتح القائمة again');
    doc.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  }

  console.log('\n📋 8) مفتاح التحديث التلقائي يتبع الاتجاه');
  {
    pick('ar');
    const rtl = $('#autoKnob').style.transform;
    ok(rtl.includes('-1rem'), 'RTL: المؤشر يتحرك يساراً', rtl);
    pick('en');
    const ltr = $('#autoKnob').style.transform;
    ok(ltr.includes('1rem'), 'LTR: المؤشر يتحرك يميناً', ltr);
    pick('ar');
  }

  console.log('\n📋 9) أخطاء الجافاسكربت');
  ok(errors.length === 0, 'لا أخطاء JS', errors.slice(0, 2).join(' | '));

  console.log(`\n════════ النتيجة: ${pass} ناجح · ${fail} فاشل ════════\n`);
  if (errors.length) console.log(errors.slice(0, 6).join('\n'));
  window.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(2); });
