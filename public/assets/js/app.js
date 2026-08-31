/* =============================================================================
 *  ظرف (Zarf Mail) — منطق الواجهة
 * -----------------------------------------------------------------------------
 *  المسؤوليات:
 *    1) إنشاء/استعادة البريد المؤقت وحفظه في localStorage
 *    2) تحديث صندوق الوارد تلقائياً كل 5 ثوانٍ (+ تحديث لحظي عبر SSE إن توفّر)
 *    3) نسخ العنوان وأكواد OTP مع إشعار تفاعلي
 *    4) عرض تفاصيل الرسالة داخل مودال أنيق بتبويبين (HTML آمن / نص)
 *    5) عدّاد تنازلي لانتهاء البريد + إعادة توليد تلقائية
 *    6) عدّة تحسينات: بحث، وضع ليلي/نهاري، اختصارات لوحة المفاتيح
 * ========================================================================== */

(function () {
  'use strict';

  /* ============================== الإعدادات ============================== */
  const REFRESH_MS = 5000;              // التحديث التلقائي كل 5 ثوانٍ (حسب المطلوب)
  const STORAGE_KEY = 'zarf:mailbox';   // مفتاح الحفظ المحلي
  const THEME_KEY = 'zarf:theme';

  /* ============================== حالة التطبيق ============================== */
  const state = {
    ttlMinutes: 7 * 24 * 60, // 7 أيام كاملة (الافتراضي؛ يُحدَّث من السيرفر)
    mailbox: null,        // { id, address, token, expiresAt }
    messages: [],         // قائمة الرسائل المعروضة
    filter: '',           // كلمة البحث
    autoRefresh: true,
    loading: false,
    fetching: false,
    lastUpdate: 0,
    seenIds: new Set(),   // لمعرفة الرسائل الجديدة وإظهار إشعار
    activeMessage: null,
    eventSource: null,
    countdownTimer: null,
    refreshTimer: null,
    firstLoad: true,
  };

  /* ============================== أدوات مساعدة ============================== */

  /** اختصار document.querySelector */
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  /* ============================== الترجمة (i18n) ============================== */
  /** اختصارات الترجمة — تقرأ من قاموس محرك اللغات في i18n.js */
  const t = (key, vars) => (window.ZarfI18n ? window.ZarfI18n.t(key, vars) : key);
  const tCount = (key, count) => (window.ZarfI18n ? window.ZarfI18n.tCount(key, count) : String(count));
  const currentLocale = () => (window.ZarfI18n ? window.ZarfI18n.getLocale() : 'ar');
  const currentDir = () => document.documentElement.dir || (currentLocale() === 'ar' ? 'rtl' : 'ltr');

  /** مُنسّق الوقت النسبي بلغة الواجهة الحالية (يُعاد بناؤه عند تغيير اللغة) */
  let rtfCache = null;
  const rtf = () => {
    if (!rtfCache) rtfCache = new Intl.RelativeTimeFormat(currentLocale(), { numeric: 'auto' });
    return rtfCache;
  };
  const resetFormatters = () => { rtfCache = null; };

  /** تنسيق الأرقام بلغة الواجهة */
  function fmtNum(n) {
    try { return new Intl.NumberFormat(currentLocale()).format(n); }
    catch (e) { return String(n); }
  }

  /** تنسيق التاريخ النسبي بلغة الواجهة */
  function timeAgo(timestamp) {
    const diff = Date.now() - timestamp;
    const sec = Math.round(diff / 1000);
    if (Math.abs(sec) < 60) return rtf().format(-sec, 'second');
    const min = Math.round(sec / 60);
    if (Math.abs(min) < 60) return rtf().format(-min, 'minute');
    const hr = Math.round(min / 60);
    if (Math.abs(hr) < 24) return rtf().format(-hr, 'hour');
    return rtf.format(-Math.round(hr / 24), 'day');
  }

  /** تنسيق الساعة والتاريخ */
  function formatDateTime(ts) {
    return new Date(ts).toLocaleString(currentLocale(), {
      hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short',
    });
  }

  /** تأخير زمني (يُستخدم في الانتظار بين المحاولات) */
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** معلومات مزوّد البريد الحالي (تُعرض في الواجهة) */
  const providerInfo = { name: 'local', real: false, domains: [] };

  /** تنسيق الحجم */
  function formatBytes(bytes) {
    const units = [t('units.bytes'), t('units.kb'), t('units.mb')];
    if (!bytes) return `0 ${units[0]}`;
    let i = 0;
    let value = bytes;
    while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
    return `${value.toFixed(value < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
  }

  /** تهريب نص HTML لمنع أي حقن */
  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** أول حرف من الاسم لصورة المرسل */
  function initial(name, email) {
    const src = (name || email || '?').trim();
    return src.charAt(0).toUpperCase();
  }

  /** لون ثابت مشتق من النص (لأفاتار المرسل) */
  function colorFromString(str = '') {
    let hash = 0;
    for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) % 360;
    return `hsl(${hash} 70% 55%)`;
  }

  /**
   * حالة إنشاء بريد جديد:
   * الإنشاء يستغرق بضع ثوانٍ لأنه ينشئ حساباً حقيقياً لدى مزوّد البريد،
   * لذلك نعرض نصاً نابضاً ونُعطّل الأزرار مؤقتاً.
   */
  function setCreating(isCreating) {
    const text = $('#emailText');
    const newBtn = $('#newEmailBtn');
    const customBtn = $('#customEmailBtn');
    const copyBtn = $('#copyBtn');

    [copyBtn, newBtn, customBtn].forEach((btn) => { if (btn) btn.disabled = isCreating; });

    if (isCreating) {
      text.classList.add('animate-pulse');
      text.textContent = t('card.preparing');
      if (newBtn) newBtn.classList.add('opacity-60');
    } else {
      text.classList.remove('animate-pulse');
      if (newBtn) newBtn.classList.remove('opacity-60');
    }
  }

  /** عرض/إخفاء شريط التحميل العلوي */
  function setLoading(isLoading) {
    state.loading = isLoading;
    $('#progress').classList.toggle('hidden', !isLoading);
    const icon = $('#refreshIcon');
    icon.classList.toggle('animate-spin', isLoading);
  }

  /** تحديث مؤشر حالة الاتصال */
  function setStatus(ok, text) {
    const dot = $('#statusDot').lastElementChild;
    dot.className = `relative inline-flex h-2 w-2 rounded-full ${ok ? 'bg-success' : 'bg-danger'}`;
    $('#statusText').textContent = text || (ok ? t('nav.statusOnline') : t('nav.statusOffline'));
  }

  /* ============================== الإشعارات (Toasts) ============================== */
  function toast(message, type = 'success', duration = 3200) {
    const box = $('#toasts');
    const styles = {
      success: { bg: 'bg-success/15', border: 'border-success/40', text: 'text-success', icon: '✓' },
      info: { bg: 'bg-brand/15', border: 'border-brand/40', text: 'text-brand', icon: 'ℹ' },
      error: { bg: 'bg-danger/15', border: 'border-danger/40', text: 'text-danger', icon: '✕' },
      warn: { bg: 'bg-warning/15', border: 'border-warning/40', text: 'text-warning', icon: '!' },
    }[type] || {};

    const el = document.createElement('div');
    el.className = `pointer-events-auto flex items-center gap-3 rounded-2xl border ${styles.border} ${styles.bg}
                    glass px-4 py-3 text-sm font-semibold shadow-card animate-toast-in`;
    el.innerHTML = `
      <span class="grid h-7 w-7 shrink-0 place-items-center rounded-xl ${styles.bg} ${styles.text}">${styles.icon}</span>
      <span class="flex-1 text-fg">${escapeHtml(message)}</span>`;

    box.appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity .3s, transform .3s';
      el.style.opacity = '0';
      el.style.transform = 'translateY(-10px)';
      setTimeout(() => el.remove(), 320);
    }, duration);
  }

  /* ============================== النسخ إلى الحافظة ============================== */
  async function copyText(text) {
    try {
      // الطريقة الحديثة (تتطلب سياقاً آمناً وإذن الكتابة)
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) { /* نكمل بالطريقة البديلة */ }

    // طريقة بديلة تعمل داخل الإطارات المعزولة
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) {
      return false;
    }
  }

  /** نسخ مع إشعار + تغيير مؤقت على الزر */
  async function copyWithFeedback(text, buttonEl, labelEl, defaultLabel) {
    const ok = await copyText(text);
    if (ok) {
      toast(t('toast.copied'), 'success');
      if (buttonEl) buttonEl.classList.add('ring-2', 'ring-success/60');
      if (labelEl) labelEl.textContent = t('card.copied');
    } else {
      toast(t('toast.copyFail'), 'warn');
      // نعرض النص في مربع اختيار لتسهيل النسخ اليدوي
      window.prompt(t('toast.copyFailPrompt'), text);
    }
    setTimeout(() => {
      if (buttonEl) buttonEl.classList.remove('ring-2', 'ring-success/60');
      if (labelEl) labelEl.textContent = defaultLabel;
    }, 1600);
  }

  /* ============================== التخزين المحلي ============================== */
  function saveMailbox(mailbox) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(mailbox)); } catch (e) { /* تجاهل */ }
  }
  function loadMailbox() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data || !data.id || !data.address) return null;
      if (data.expiresAt && data.expiresAt < Date.now()) return null; // منتهي
      return data;
    } catch (e) { return null; }
  }
  function clearMailbox() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* تجاهل */ }
  }

  /* ============================== طبقة الـ API ============================== */
  async function api(path, options = {}) {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options,
    });
    let json = null;
    try { json = await res.json(); } catch (e) { json = null; }

    if (!res.ok) {
      const error = new Error((json && json.error) || t('toast.httpError', { status: res.status }));
      error.status = res.status;
      error.code = json && json.code;
      throw error;
    }
    return json;
  }

  /* ============================== شاشة التحميل الأولية ============================== */
  function renderSkeleton() {
    const list = $('#messagesList');
    list.innerHTML = Array.from({ length: 3 }).map(() => `
      <div class="flex gap-3 p-4">
        <div class="skeleton h-11 w-11 rounded-2xl"></div>
        <div class="flex-1 space-y-2 py-1">
          <div class="skeleton h-4 w-1/3"></div>
          <div class="skeleton h-3 w-2/3"></div>
          <div class="skeleton h-3 w-1/2"></div>
        </div>
      </div>`).join('');
  }

  /* ============================== عرض الرسائل ============================== */
  function renderMessages() {
    const list = $('#messagesList');
    const empty = $('#emptyState');

    const term = state.filter.trim().toLowerCase();
    const items = state.messages.filter((m) => {
      if (!term) return true;
      return (
        (m.subject || '').toLowerCase().includes(term) ||
        (m.from.address || '').toLowerCase().includes(term) ||
        (m.from.name || '').toLowerCase().includes(term) ||
        (m.snippet || '').toLowerCase().includes(term) ||
        (m.otp || '').includes(term)
      );
    });

    if (!items.length) {
      list.innerHTML = '';
      empty.classList.remove('hidden');
      empty.classList.add('flex');
      if (state.filter) {
        // لا نعرض زر الرسالة التجريبية أثناء البحث
        $('#demoBtn').classList.add('hidden');
      } else {
        $('#demoBtn').classList.remove('hidden');
      }
    } else {
      empty.classList.add('hidden');
      empty.classList.remove('flex');
      list.innerHTML = items.map(messageRowHtml).join('');

      // ربط الأحداث بكل صف
      $$('#messagesList [data-message-id]').forEach((row) => {
        row.addEventListener('click', () => openMessage(row.dataset.messageId));
      });
      $$('#messagesList [data-copy-otp]').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          await copyWithFeedback(btn.dataset.copyOtp, btn, null, null);
        });
      });
    }

    // العدّادات
    const unread = state.messages.filter((m) => !m.isRead).length;
    $('#messagesCount').textContent = tCount('inbox.count', state.messages.length);
    const unreadChip = $('#unreadCount');
    unreadChip.classList.toggle('hidden', unread === 0);
    unreadChip.textContent = t('inbox.unread', { count: fmtNum(unread) });

    // شريط OTP السريع: أحدث رسالة تحتوي كوداً
    const latestOtp = state.messages.find((m) => m.otp);
    const strip = $('#otpStrip');
    if (latestOtp) {
      $('#otpStripCode').textContent = latestOtp.otp;
      strip.classList.remove('hidden');
    } else {
      strip.classList.add('hidden');
    }

    // وقت آخر تحديث
    $('#lastUpdate').textContent = state.lastUpdate
      ? t('inbox.lastUpdate', { time: formatDateTime(state.lastUpdate) })
      : t('inbox.lastUpdateEmpty');
  }

  /** بناء HTML لصف رسالة واحد */
  function messageRowHtml(m) {
    const name = escapeHtml(m.from.name || m.from.address.split('@')[0]);
    const email = escapeHtml(m.from.address);
    const subject = escapeHtml(m.subject || t('subject.none'));
    const snippet = escapeHtml(m.snippet || '');
    const avatarColor = colorFromString(m.from.address);

    return `
      <div data-message-id="${m.id}" class="message-row group ${m.isRead ? '' : 'unread'}">
        <!-- الأفاتار -->
        <span class="grid h-11 w-11 shrink-0 place-items-center rounded-2xl text-base font-black text-white"
              style="background:${avatarColor}">${escapeHtml(initial(m.from.name, m.from.address))}</span>

        <!-- المحتوى -->
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2">
            <p class="truncate text-sm font-bold ${m.isRead ? 'text-fg/80' : 'text-fg'}">${name}</p>
            ${m.isRead ? '' : '<span class="h-2 w-2 shrink-0 rounded-full bg-accent"></span>'}
            <span class="ms-auto shrink-0 text-[11px] text-muted">${timeAgo(m.receivedAt)}</span>
          </div>
          <p class="mt-0.5 truncate text-sm ${m.isRead ? 'text-muted' : 'font-semibold text-fg/90'}">${subject}</p>
          <p class="mt-1 line-clamp-1 text-xs leading-6 text-muted">${snippet}</p>

          <!-- كود التحقق داخل الصف -->
          ${m.otp ? `
            <div class="mt-2 inline-flex items-center gap-2 rounded-xl border border-warning/40 bg-warning/10 px-3 py-1.5">
              <span class="text-[11px] font-semibold text-warning">${escapeHtml(t('otp.badge'))}</span>
              <span class="font-mono text-sm font-black tracking-[.25em] text-fg">${escapeHtml(m.otp)}</span>
              <button data-copy-otp="${escapeHtml(m.otp)}" class="rounded-lg p-1 text-warning transition hover:bg-warning/20" title="${escapeHtml(t('otp.copy'))}">
                <svg viewBox="0 0 24 24" fill="none" class="h-3.5 w-3.5" aria-hidden="true">
                  <rect x="9" y="9" width="11" height="11" rx="2.5" stroke="currentColor" stroke-width="2"/>
                  <path d="M15 6.5V6A2 2 0 0 0 13 4H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                </svg>
              </button>
            </div>` : ''}
        </div>
      </div>`;
  }

  /* ============================== جلب البيانات ============================== */
  async function fetchInbox({ silent = false, sync = false } = {}) {
    if (!state.mailbox) return false;
    // لا نتجاهل الطلب إذا كان التحميل ناتجاً عن عملية أخرى (مثل إنشاء بريد)،
    // بل نمنع التكرار المتوازي فقط عبر مؤشر مستقل
    if (state.fetching) return false;
    state.fetching = true;
    if (!silent) setLoading(true);

    try {
      // sync=1 → مزامنة فورية مع خدمة البريد (تُستخدم عند ضغطة "تحديث")
      const query = sync ? '?limit=50&sync=1' : '?limit=50';
      const data = await api(`/api/check-inbox/${encodeURIComponent(state.mailbox.id)}${query}`);
      const incoming = data.data.messages || [];

      // اكتشاف الرسائل الجديدة لإشعار المستخدم
      const fresh = incoming.filter((m) => !state.seenIds.has(m.id));
      incoming.forEach((m) => state.seenIds.add(m.id));

      if (!state.firstLoad) {
        fresh.forEach((m) => {
          if (m.otp) toast(t('toast.newOtp', { code: m.otp }), 'info', 6000);
          else toast(t('toast.newMessage', { sender: m.from.name || m.from.address }), 'info');
        });
      }

      state.messages = incoming;
      state.lastUpdate = data.data.serverTime || Date.now();
      state.mailbox.expiresAt = data.data.mailbox.expiresAt;

      setStatus(true);
      renderMessages();
      state.firstLoad = false;
      return true;
    } catch (error) {
      setStatus(false, t('toast.noConnection'));
      if (!silent) toast(error.message, 'error');

      // إن كان البريد منتهياً أو محذوفاً → نجهّز بريداً جديداً تلقائياً
      if (error.status === 404) {
        state.fetching = false;
        clearMailbox();
        state.mailbox = null;
        await createMailbox();
      }
      return false;
    } finally {
      state.fetching = false;
      setLoading(false);
    }
  }

  /* ============================== إنشاء بريد ============================== */
  async function createMailbox(custom) {
    setLoading(true);
    setCreating(true);
    let created = false;
    try {
      const body = {};
      if (custom) body.custom = custom;
      const data = await api('/api/generate-email', { method: 'POST', body: JSON.stringify(body) });

      state.mailbox = {
        id: data.data.id,
        address: data.data.address,
        token: data.data.token,
        expiresAt: data.data.expiresAt,
        createdAt: data.data.createdAt,
        ttlMinutes: data.data.ttlMinutes,
      };
      if (data.data.ttlMinutes) state.ttlMinutes = data.data.ttlMinutes;
      state.messages = [];
      state.seenIds = new Set();
      state.firstLoad = true;

      saveMailbox(state.mailbox);
      $('#emailText').textContent = state.mailbox.address;
      $('#emailText').title = state.mailbox.address;

      renderMessages();
      startCountdown();
      connectStream();
      created = true;
    } catch (error) {
      toast(error.message, 'error');
      created = false;
    } finally {
      setLoading(false);
      setCreating(false);
    }

    if (created) {
      toast(custom ? t('toast.changed') : t('toast.created'), 'success');
      // نجلب الصندوق بعد إطفاء مؤشر التحميل حتى لا يُلغى الطلب
      await fetchInbox({ silent: true });
    }
    return created;
  }

  /* ============================== حذف البريد ============================== */
  async function deleteMailbox() {
    if (!state.mailbox) return;
    try {
      await api('/api/delete-email', {
        method: 'POST',
        body: JSON.stringify({ emailId: state.mailbox.id, token: state.mailbox.token }),
      });
      clearMailbox();
      state.mailbox = null;
      state.messages = [];
      state.seenIds = new Set();
      renderMessages();
      closeStream();
      toast(t('toast.deleted'), 'success');
      await createMailbox();
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  /* ============================== العدّاد التنازلي ============================== */
  /** إجمالي مدة الصلاحية بالميللي ثانية: من السيرفر إن وُجد، وإلا 7 أيام */
  function ttlTotalMs() {
    if (state.ttlMinutes) return state.ttlMinutes * 60 * 1000;
    const created = state.mailbox && state.mailbox.createdAt ? new Date(state.mailbox.createdAt).getTime() : null;
    const expires = state.mailbox && state.mailbox.expiresAt ? new Date(state.mailbox.expiresAt).getTime() : null;
    return created && expires && expires > created ? (expires - created) : 7 * 24 * 60 * 60 * 1000;
  }

  function startCountdown() {
    if (state.countdownTimer) clearInterval(state.countdownTimer);

    const tick = () => {
      if (!state.mailbox) return;
      const remaining = state.mailbox.expiresAt - Date.now();

      if (remaining <= 0) {
        clearInterval(state.countdownTimer);
        $('#countdownText').textContent = t('ttl.expired');
        toast(t('toast.expired'), 'warn');
        clearMailbox();
        state.mailbox = null;
        createMailbox();
        return;
      }

      // 7 أيام: نعرض الأيام ثم الساعات والدقائق والثواني
      const total = ttlTotalMs();
      const totalSec = Math.floor(remaining / 1000);
      const days = Math.floor(totalSec / 86400);
      const hh = String(Math.floor((totalSec % 86400) / 3600)).padStart(2, '0');
      const mm = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0');
      const ss = String(totalSec % 60).padStart(2, '0');

      $('#countdownText').textContent = days > 0
        ? `${fmtNum(days)}${t('ttl.daysShort')} ${hh}:${mm}:${ss}`
        : `${mm}:${ss}`;

      // ملاحظة توضيحية: البريد صالح 7 أيام كاملة
      const note = $('#ttlNote');
      if (note) note.textContent = t('ttl.validFor', { days: fmtNum(Math.round(total / 86400000)) });

      // الحلقة الدائرية: نسبة الوقت المتبقي من إجمالي المدة (7 أيام)
      const ring = $('#countdownRing');
      const ratio = Math.max(0, Math.min(1, remaining / total));
      const circumference = 2 * Math.PI * 15.5; // ≈ 97.4
      ring.setAttribute('stroke-dasharray', circumference.toFixed(1));
      ring.setAttribute('stroke-dashoffset', (circumference * (1 - ratio)).toFixed(1));

      // تحذير بصري عند آخر ساعة
      ring.setAttribute('stroke', remaining < 60 * 60 * 1000 ? 'rgb(var(--danger))' : 'rgb(var(--accent))');
    };

    tick();
    state.countdownTimer = setInterval(tick, 1000);
  }

  /* ============================== التحديث اللحظي (SSE) ============================== */
  function connectStream() {
    closeStream();
    if (!state.mailbox || typeof EventSource === 'undefined') return;

    try {
      const es = new EventSource(`/api/stream/${encodeURIComponent(state.mailbox.id)}`);
      es.addEventListener('update', () => fetchInbox({ silent: true }));
      es.onerror = () => { /* نتجاهل: التحديث الدوري كل 5 ثوانٍ يغطي الأمر */ };
      state.eventSource = es;
    } catch (e) { /* تجاهل */ }
  }
  function closeStream() {
    if (state.eventSource) {
      state.eventSource.close();
      state.eventSource = null;
    }
  }

  /* ============================== مودال الرسالة ============================== */
  async function openMessage(messageId) {
    if (!state.mailbox) return;
    setLoading(true);
    try {
      const data = await api(`/api/messages/${encodeURIComponent(state.mailbox.id)}/${encodeURIComponent(messageId)}`);
      const m = data.data;
      state.activeMessage = m;

      $('#modalSenderName').textContent = m.from.name || m.from.address;
      $('#modalSenderEmail').textContent = m.from.address;
      $('#modalSubject').textContent = m.subject || t('subject.none');
      $('#modalTo').textContent = m.to || state.mailbox.address;
      $('#modalTime').textContent = formatDateTime(m.receivedAt);
      $('#modalSize').textContent = formatBytes(m.size);

      // كود التحقق في الأعلى
      const otpBox = $('#modalOtp');
      if (m.otp) {
        $('#modalOtpCode').textContent = m.otp;
        otpBox.classList.remove('hidden');
      } else {
        otpBox.classList.add('hidden');
      }

      // المرفقات
      const attBox = $('#modalAttachments');
      if (m.attachments && m.attachments.length) {
        attBox.innerHTML = m.attachments.map((a) => `
          <span class="zarf-chip !text-[11px]">
            📎 ${escapeHtml(a.filename || t('attachment'))} · ${formatBytes(a.size)}
          </span>`).join('');
        attBox.classList.remove('hidden');
        attBox.classList.add('flex');
      } else {
        attBox.classList.add('hidden');
        attBox.classList.remove('flex');
      }

      // المحتوى: HTML داخل إطار معزول + النص الأصلي
      renderMessageFrame(m);
      const hasHtml = !!(m.html && m.html.trim().length > 0);

      $('#tabText').textContent = m.text || t('text.none');
      showTab(hasHtml ? 'html' : 'text');

      // تعليم الرسالة كمقروءة محلياً
      const target = state.messages.find((x) => x.id === m.id);
      if (target) target.isRead = true;
      renderMessages();

      $('#messageModal').classList.remove('hidden');
      document.body.style.overflow = 'hidden';
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      setLoading(false);
    }
  }

  /**
   * يعرض محتوى HTML للرسالة داخل إطار معزول تماماً (sandbox="").
   * الغلاف يتبع لغة الواجهة واتجاهها، ويُعاد رسمه عند تغيير اللغة.
   */
  function renderMessageFrame(m) {
    const frame = $('#mailHtmlFrame');
    if (!frame) return;
    const hasHtml = !!(m && m.html && m.html.trim().length > 0);
    const head = `<!DOCTYPE html><html lang="${currentLocale()}" dir="${currentDir()}"><head><meta charset="utf-8">`;

    if (hasHtml) {
      frame.srcdoc = `${head}
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <style>
          body{font-family:system-ui,-apple-system,'Segoe UI',Tahoma,sans-serif;
               margin:18px;color:#111827;line-height:1.75;background:#ffffff;font-size:15px}
          img{max-width:100%;height:auto}
          a{color:#4f46e5}
          table{max-width:100%}
        </style></head><body>${m.html}</body></html>`;
    } else {
      frame.srcdoc = `${head}</head>
        <body style="font-family:system-ui;padding:24px;color:#6b7280">${escapeHtml(t('modal.noHtml'))}</body></html>`;
    }
  }

  function closeMessageModal() {
    $('#messageModal').classList.add('hidden');
    document.body.style.overflow = '';
    state.activeMessage = null;
    // تفريغ الإطار لتحرير الذاكرة
    $('#mailHtmlFrame').srcdoc = '';
  }

  /** تبديل تبويب العرض داخل المودال */
  function showTab(tab) {
    const isHtml = tab === 'html';
    $('#tabHtml').classList.toggle('hidden', !isHtml);
    $('#tabText').classList.toggle('hidden', isHtml);
    $$('#modalTabs button').forEach((btn) => {
      const active = btn.dataset.tab === tab;
      btn.className = active
        ? 'zarf-btn !bg-brand/15 !px-3 !py-1.5 !text-xs !text-brand'
        : 'zarf-btn-soft !px-3 !py-1.5 !text-xs';
    });
  }

  async function deleteActiveMessage() {
    const m = state.activeMessage;
    if (!m || !state.mailbox) return;
    try {
      await api(`/api/messages/${encodeURIComponent(state.mailbox.id)}/${encodeURIComponent(m.id)}`, {
        method: 'DELETE',
      });
      state.messages = state.messages.filter((x) => x.id !== m.id);
      renderMessages();
      closeMessageModal();
      toast(t('toast.msgDeleted'), 'success');
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  /* ============================== مودال التأكيد ============================== */
  let confirmAction = null;
  function askConfirm(title, text, action) {
    $('#confirmTitle').textContent = title;
    $('#confirmText').textContent = text;
    confirmAction = action;
    $('#confirmModal').classList.remove('hidden');
  }
  function closeConfirm() {
    $('#confirmModal').classList.add('hidden');
    confirmAction = null;
  }

  /* ============================== الوضع الليلي ============================== */
  function applyTheme(theme) {
    const html = document.documentElement;
    if (theme === 'light') {
      html.classList.add('light');
      $('#iconMoon').classList.add('hidden');
      $('#iconSun').classList.remove('hidden');
    } else {
      html.classList.remove('light');
      $('#iconMoon').classList.remove('hidden');
      $('#iconSun').classList.add('hidden');
    }
    try { localStorage.setItem(THEME_KEY, theme); } catch (e) { /* تجاهل */ }
  }
  function initTheme() {
    let saved = null;
    try { saved = localStorage.getItem(THEME_KEY); } catch (e) { /* تجاهل */ }
    applyTheme(saved || 'dark'); // الداكن هو الافتراضي
  }

  /* ============================== الدومينات ============================== */

  /** شارة المزوّد: تُظهر للمستخدم أن بريده حقيقي ويستقبل من الإنترنت */
  function paintProviderBadge() {
    const badge = $('#providerBadge');
    if (!badge) return;
    badge.classList.remove('hidden');
    if (providerInfo.real) {
      badge.innerHTML = `
        <span class="relative flex h-2 w-2">
          <span class="absolute inline-flex h-full w-full animate-ping-slow rounded-full bg-success/70"></span>
          <span class="relative inline-flex h-2 w-2 rounded-full bg-success"></span>
        </span>
        ${escapeHtml(t('card.providerReal'))}`;
    } else {
      badge.innerHTML = `🧪 ${escapeHtml(t('card.providerLocal'))}`;
    }
  }

  /** تنبيه صغير تحت حقل الاسم المخصص */
  function applyCustomHint() {
    const hint = $('#customHint');
    if (hint && providerInfo.real) {
      hint.textContent = t('custom.hint');
      hint.classList.remove('hidden');
    }
  }
  async function loadDomains() {
    try {
      const data = await api('/api/domains');
      providerInfo.name = data.provider || 'local';
      providerInfo.real = !!data.real;
      providerInfo.domains = data.domains || [];

      $('#domainsChips').innerHTML = (data.domains || []).map((d) => `
        <span class="zarf-chip ${d === data.defaultDomain ? '!border-brand/40 !bg-brand/10 !text-brand' : ''}">
          @${escapeHtml(d)}
        </span>`).join('');
      $('#customDomain').textContent = data.defaultDomain || 'zarf.mail';

      // شارة المزوّد + تنبيه الاسم المخصص (يُرسمان بلغة الواجهة الحالية)
      paintProviderBadge();
      applyCustomHint();
      return data;
    } catch (e) {
      $('#domainsChips').innerHTML = '<span class="zarf-chip">zarf.mail</span>';
      return null;
    }
  }

  /* ============================== ربط الأحداث ============================== */
  /* ------------------------------------------------------------------
   *  مبدّل اللغة — قائمة منسدلة أنيقة، تبديل فوري بدون إعادة تحميل
   * ------------------------------------------------------------------ */
  const I18n = () => window.ZarfI18n;

  function updateLangButton() {
    const lang = I18n().getCurrentLang();
    $('#langCurrent').textContent = lang.native;
    const short = $('#langCurrentShort');
    if (short) short.textContent = lang.code.toUpperCase();
  }

  function buildLangMenu() {
    const menu = $('#langMenu');
    if (!menu) return;
    const current = I18n().getLocale();
    menu.innerHTML = I18n()
      .LANGS.map(
        (l) => `
        <button type="button" role="option" aria-selected="${l.code === current}" data-lang="${l.code}"
                tabindex="${l.code === current ? '0' : '-1'}"
                class="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm transition-colors hover:bg-surface2 focus:outline-none focus:ring-2 focus:ring-brand/50 ${
                  l.code === current ? 'bg-brand/15 font-semibold text-brand' : 'text-fg'
                }">
          <span class="text-base leading-none">${l.flag}</span>
          <span class="flex-1 text-start">${l.native}</span>
          <span class="text-[10px] font-mono text-muted">${l.dir === 'rtl' ? 'RTL' : 'LTR'}</span>
        </button>`
      )
      .join('');

    menu.querySelectorAll('[data-lang]').forEach((btn) => {
      btn.addEventListener('click', () => {
        I18n().setLocale(btn.dataset.lang);
        closeLangMenu({ focusButton: true });
      });
    });
    updateLangButton();
  }

  function openLangMenu() {
    const menu = $('#langMenu');
    menu.classList.remove('hidden');
    menu.classList.add('animate-pop-in');
    $('#langBtn').setAttribute('aria-expanded', 'true');

    // نضع المؤشر على اللغة المختارة حالياً
    const active = menu.querySelector('[aria-selected="true"]') || menu.querySelector('[data-lang]');
    if (active) {
      if (active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
      active.focus();
    }
  }

  function closeLangMenu({ focusButton = false } = {}) {
    const menu = $('#langMenu');
    menu.classList.add('hidden');
    $('#langBtn').setAttribute('aria-expanded', 'false');
    if (focusButton) $('#langBtn').focus();
  }

  function toggleLangMenu() {
    $('#langMenu').classList.contains('hidden') ? openLangMenu() : closeLangMenu();
  }

  const langMenuOpen = () => $('#langMenu') && !$('#langMenu').classList.contains('hidden');

  /** تنقّل بلوحة المفاتيح داخل القائمة (↑ ↓ Home End Esc) */
  function bindLangKeyboard() {
    const menu = $('#langMenu');

    menu.addEventListener('keydown', (e) => {
      const items = Array.from(menu.querySelectorAll('[data-lang]'));
      if (!items.length) return;
      const index = items.indexOf(document.activeElement);

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const dir = e.key === 'ArrowDown' ? 1 : -1;
        const next = items[(index + dir + items.length) % items.length];
        items.forEach((b) => b.setAttribute('tabindex', '-1'));
        next.setAttribute('tabindex', '0');
        next.focus();
      } else if (e.key === 'Home') {
        e.preventDefault();
        items[0].focus();
      } else if (e.key === 'End') {
        e.preventDefault();
        items[items.length - 1].focus();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeLangMenu({ focusButton: true });
      }
    });

    // إغلاق بـ Esc حتى لو كان المؤشر على الزر نفسه
    $('#langBtn').addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && langMenuOpen()) {
        e.preventDefault();
        closeLangMenu({ focusButton: true });
      }
      if ((e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') && !langMenuOpen()) {
        e.preventDefault();
        openLangMenu();
      }
    });
  }

  function bindLangEvents() {
    buildLangMenu();
    bindLangKeyboard();

    $('#langBtn').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleLangMenu();
    });

    document.addEventListener('click', (e) => {
      const wrap = $('#langWrap');
      if (wrap && !wrap.contains(e.target)) closeLangMenu();
    });

    /** إعادة بناء الواجهة بالكامل عند تغيير اللغة — بدون إعادة تحميل الصفحة */
    I18n().onChange(() => {
      resetFormatters();       // تحديث مُنسّقات التاريخ/الأرقام
      updateLangButton();      // اسم اللغة على الزر
      buildLangMenu();         // تمييز اللغة المختارة
      renderMessages();        // إعادة رسم الصندوق باللغة الجديدة
      if (typeof state.paintSwitch === 'function') state.paintSwitch(); // مفتاح التحديث التلقائي
      paintProviderBadge();    // شارة المزوّد
      applyCustomHint();       // تنبيه الاسم المخصص
      $('#emailText').textContent = state.mailbox ? state.mailbox.address : t('card.preparing');
      if (state.mailbox) startCountdown(); // العدّاد بلغة جديدة
      if (state.activeMessage && !$('#messageModal').classList.contains('hidden')) {
        renderMessageFrame(state.activeMessage); // إطار الرسالة يتبع الاتجاه الجديد
      }
    });
  }

  function bindEvents() {
    // نسخ العنوان
    $('#copyBtn').addEventListener('click', () => {
      if (state.mailbox) copyWithFeedback(state.mailbox.address, $('#copyBtn'), $('#copyLabel'), t('card.copy'));
    });

    // نسخ كود التحقق من الشريط السريع
    $('#otpStripCopy').addEventListener('click', () => {
      const code = $('#otpStripCode').textContent.trim();
      if (code && code !== '—') copyWithFeedback(code, $('#otpStripCopy'), null, t('otp.copy'));
    });

    // بريد جديد
    $('#newEmailBtn').addEventListener('click', () => {
      askConfirm(t('confirm.newTitle'), t('confirm.newText'), async () => {
        closeConfirm();
        await deleteMailbox();
      });
    });

    // الاسم المخصص
    const customRow = $('#customRow');
    $('#customEmailBtn').addEventListener('click', () => {
      customRow.classList.toggle('hidden');
      customRow.classList.toggle('flex');
      if (!customRow.classList.contains('hidden')) $('#customInput').focus();
    });
    $('#cancelCustomBtn').addEventListener('click', () => {
      customRow.classList.add('hidden');
      customRow.classList.remove('flex');
    });
    $('#applyCustomBtn').addEventListener('click', async () => {
      const value = $('#customInput').value.trim();
      if (!value) return toast(t('toast.nameRequired'), 'warn');
      const ok = await createMailbox(value);
      if (ok) {
        customRow.classList.add('hidden');
        customRow.classList.remove('flex');
        $('#customInput').value = '';
      }
    });
    $('#customInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('#applyCustomBtn').click();
    });

    // حذف البريد
    $('#deleteEmailBtn').addEventListener('click', () => {
      askConfirm(t('confirm.delTitle'), t('confirm.delText'), async () => {
        closeConfirm();
        await deleteMailbox();
      });
    });

    // تحديث يدوي (مع مزامنة فورية من خدمة البريد)
    $('#refreshBtn').addEventListener('click', () => fetchInbox({ sync: true }));

    // البحث
    $('#searchInput').addEventListener('input', (e) => {
      state.filter = e.target.value;
      renderMessages();
    });

    // التحديث التلقائي
    const autoToggle = $('#autoToggle');
    const autoSwitch = $('#autoSwitch');
    const autoKnob = $('#autoKnob');
    // في RTL يتحرك المؤشر يساراً، وفي LTR يميناً — بحسب اتجاه الصفحة
    const paintSwitch = () => {
      autoSwitch.classList.toggle('bg-brand', state.autoRefresh);
      autoSwitch.classList.toggle('bg-line', !state.autoRefresh);
      const sign = currentDir() === 'rtl' ? -1 : 1;
      autoKnob.style.transform = state.autoRefresh ? `translateX(${sign}rem)` : 'translateX(0)';
    };
    state.paintSwitch = paintSwitch; // يُستدعى مجدداً عند تغيير اللغة
    autoToggle.addEventListener('change', (e) => {
      state.autoRefresh = e.target.checked;
      paintSwitch();
      toast(state.autoRefresh ? t('toast.autoOn') : t('toast.autoOff'), 'info', 1800);
    });
    paintSwitch();

    // المودالات
    $('#modalClose').addEventListener('click', closeMessageModal);
    $('#modalDismiss').addEventListener('click', closeMessageModal);
    $('#modalBackdrop').addEventListener('click', closeMessageModal);
    $('#modalDelete').addEventListener('click', () => {
      askConfirm(t('confirm.delMsgTitle'), t('confirm.delMsgText'), () => {
        closeConfirm();
        deleteActiveMessage();
      });
    });
    $('#modalOtpCopy').addEventListener('click', () => {
      const code = $('#modalOtpCode').textContent.trim();
      if (code) copyWithFeedback(code, $('#modalOtpCopy'), null, t('otp.copy'));
    });
    $$('#modalTabs button').forEach((btn) => {
      btn.addEventListener('click', () => showTab(btn.dataset.tab));
    });

    $('#howBtn').addEventListener('click', () => $('#howModal').classList.remove('hidden'));
    $('#howClose').addEventListener('click', () => $('#howModal').classList.add('hidden'));
    $('#howBackdrop').addEventListener('click', () => $('#howModal').classList.add('hidden'));

    $('#confirmCancel').addEventListener('click', closeConfirm);
    $('#confirmBackdrop').addEventListener('click', closeConfirm);
    $('#confirmOk').addEventListener('click', () => {
      const action = confirmAction;
      closeConfirm();
      if (action) action();
    });

    // الوضع الليلي
    $('#themeToggle').addEventListener('click', () => {
      applyTheme(document.documentElement.classList.contains('light') ? 'dark' : 'light');
    });

    // رسالة تجريبية: مع mail.tm تُرسل بريداً حقيقياً إلى عنوانك!
    $('#demoBtn').addEventListener('click', async () => {
      const btn = $('#demoBtn');
      btn.disabled = true;
      try {
        const res = await api('/api/demo/inject', {
          method: 'POST',
          body: JSON.stringify({ emailId: state.mailbox ? state.mailbox.id : undefined, kind: 'otp' }),
        });

        if (res.mode === 'real') {
          toast(t('toast.realSent'), 'success', 4000);
          // ننتظر وصولها (المزامنة تعمل كل 8 ثوانٍ في الخلفية)
          for (let i = 0; i < 5; i++) {
            await sleep(5000);
            await fetchInbox({ silent: true, sync: true });
            if (state.messages.length) break;
          }
          if (!state.messages.length) toast(t('toast.notArrived'), 'info', 4000);
        } else {
          toast(res.mode === 'local' ? t('toast.demoInjected') : t('toast.demoSent'), 'success');
          await fetchInbox({ silent: true });
        }
      } catch (error) {
        toast(error.message, 'error', 5000);
      } finally {
        btn.disabled = false;
      }
    });

    // تحديث عند العودة للتبويب
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && state.mailbox) fetchInbox({ silent: true });
    });
    window.addEventListener('online', () => { setStatus(true); fetchInbox({ silent: true }); });
    window.addEventListener('offline', () => setStatus(false, t('nav.noInternet')));

    // اختصارات لوحة المفاتيح
    document.addEventListener('keydown', (e) => {
      if (e.target.matches('input, textarea')) return;
      if (langMenuOpen()) return; // لا نُفعّل الاختصارات وقائمة اللغات مفتوحة
      if (e.key === 'Escape') {
        if (!$('#confirmModal').classList.contains('hidden')) return closeConfirm();
        if (!$('#messageModal').classList.contains('hidden')) return closeMessageModal();
        if (!$('#howModal').classList.contains('hidden')) return $('#howModal').classList.add('hidden');
      }
      if (e.key === 'r' || e.key === 'R') fetchInbox();
      if (e.key === 'n' || e.key === 'N') $('#newEmailBtn').click();
      if (e.key === 'c' || e.key === 'C') $('#copyBtn').click();
    });
  }

  /* ============================== الإقلاع ============================== */
  async function init() {
    // محرك اللغات أولاً: يضبط lang/dir ويترجم كل عناصر data-i18n قبل أي رسم
    window.ZarfI18n.init();
    bindLangEvents();

    initTheme();
    $('#year').textContent = new Date().getFullYear();

    const domains = await loadDomains();
    renderSkeleton();
    bindEvents();

    // استعادة البريد المحفوظ أو إنشاء جديد
    const saved = loadMailbox();
    if (saved) {
      $('#emailText').textContent = saved.address;
      state.mailbox = saved;
      startCountdown();
      connectStream();
      // نزامن فوراً عند فتح الصفحة (ثم يتولى العامل الدوري المهمة)
      const ok = await fetchInbox({ silent: true, sync: true });
      if (!ok && !state.mailbox) await createMailbox();
    } else {
      await createMailbox();
    }

    // التحديث التلقائي الدوري (المطلوب: كل 5 ثوانٍ)
    state.refreshTimer = setInterval(() => {
      if (!state.autoRefresh) return;
      if (document.visibilityState !== 'visible') return;
      fetchInbox({ silent: true });
    }, REFRESH_MS);

    // فحص صحة السيرفر كل 30 ثانية لتحديث مؤشر الحالة
    setInterval(async () => {
      try { await api('/api/health'); setStatus(true); } catch (e) { setStatus(false, t('nav.serverDown')); }
    }, 30000);
  }

  /** نقطة فحص للتصحيح والدعم الفني (لا تكشف أي سر: التوكن موجود أصلاً في localStorage) */
  window.__zarfState = state;

  document.addEventListener('DOMContentLoaded', init);
})();
