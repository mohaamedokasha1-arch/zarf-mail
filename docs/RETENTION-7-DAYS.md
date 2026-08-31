# ⏳ مهلة الـ 7 أيام — توثيق الباكند (Backend)

> **القاعدة:** كل بريد مؤقت وكل رسالة تُحذف تلقائياً بعد **7 أيام كاملة (10,080 دقيقة)** —
> محلياً من قاعدة بيانات ظرف، **وعلى خدمة mail.tm نفسها**.
> لا يُحذف أي شيء قبل انقضاء المهلة.

---

## 1) الإعدادات — `server/config.js`

```js
  // ===================== مدة الحياة (TTL) =====================
  // 7 أيام كاملة = 7 × 24 × 60 = 10080 دقيقة
  mailboxTtlMinutes: num(process.env.MAILBOX_TTL_MINUTES, 7 * 24 * 60),
  messageTtlMinutes: num(process.env.MESSAGE_TTL_MINUTES, 7 * 24 * 60),

  // فاصل عمل عامل التنظيف الداخلي (بالدقائق) — مرة كل ساعة
  cleanupIntervalMinutes: num(process.env.CLEANUP_INTERVAL_MINUTES, 60),
```

## 2) المتغيرات — `.env` (ونسختها `.env.example`)

```env
# ── مدة الحياة: 7 أيام كاملة ──────────────────────────────
MAILBOX_TTL_MINUTES=10080        # 7 × 24 × 60
MESSAGE_TTL_MINUTES=10080        # 7 × 24 × 60
CLEANUP_INTERVAL_MINUTES=60      # فحص كل ساعة (يحذف ما تجاوز 7 أيام فقط)
```

---

## 3) حساب الوقت المتبقي — `server/lib/utils.js`

```js
/**
 * يفكّك زمناً متبقياً (بالميلي ثانية) إلى أيام/ساعات/دقائق/ثوانٍ
 * @param {number} ms
 * @returns {{totalMs:number, days:number, hours:number, minutes:number, seconds:number, expired:boolean}}
 */
function breakdownRemaining(ms) {
  const total = Math.max(0, Number(ms) || 0);
  const totalSeconds = Math.floor(total / 1000);
  return {
    totalMs: total,
    days: Math.floor(totalSeconds / 86400),
    hours: Math.floor((totalSeconds % 86400) / 3600),
    minutes: Math.floor((totalSeconds % 3600) / 60),
    seconds: totalSeconds % 60,
    expired: total <= 0,
  };
}

/** يحوّل الدقائق إلى عدد أيام */
const minutesToDays = (minutes) => Math.round((Number(minutes) / (24 * 60)) * 10) / 10;

/**
 * تحويل آمن إلى نص ISO — لا يرمي خطأً أبداً (يُرجع null عند قيمة غير صالحة).
 * يحمي الواجهة من انهيار الطلب بسبب "Invalid time value".
 */
function safeIso(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  const time = date.getTime();
  if (!Number.isFinite(time)) return null;
  try { return date.toISOString(); } catch (e) { return null; }
}
```

---

## 4) ما تُرجعه الواجهات — `server/services/mailbox.js`

### أ) الصندوق (`serializeMailbox`)

```js
function serializeMailbox(mailbox, { withToken = false } = {}) {
  const remainingMs = Math.max(0, mailbox.expires_at - Date.now());
  const data = {
    id: mailbox.id,
    emailId: mailbox.id,
    address: mailbox.address,
    domain: mailbox.domain,
    provider: mailbox.provider || 'local',
    realInbox: (mailbox.provider || 'local') !== 'local',
    createdAt: mailbox.created_at,
    expiresAt: mailbox.expires_at,
    expiresAtISO: safeIso(mailbox.expires_at),
    ttlMinutes: config.mailboxTtlMinutes,                 // 10080
    ttlDays: minutesToDays(config.mailboxTtlMinutes),     // 7
    remainingMs,                                          // 604800000 مثلاً
    remaining: breakdownRemaining(remainingMs),           // { days, hours, minutes, seconds, expired }
    remainingLabel: formatRemainingLabel(remainingMs),    // "6 يوم و 23:59"
    messageCount: mailbox.message_count,
    lastSyncedAt: mailbox.last_synced_at || null,
  };
  if (withToken) data.token = mailbox.token;
  return data;
}

/** نص مقروء للوقت المتبقي: "6 أيام و 23:59" أو "12:34" */
function formatRemainingLabel(ms) {
  const b = breakdownRemaining(ms);
  if (b.expired) return 'منتهي';
  const hhmm = `${String(b.hours).padStart(2, '0')}:${String(b.minutes).padStart(2, '0')}`;
  return b.days > 0 ? `${b.days} يوم و ${hhmm}` : hhmm;
}
```

### ب) الرسالة (`serializeMessage`)

```js
const base = {
  id: row.id,
  from: { name: row.from_name || row.from_address.split('@')[0], address: row.from_address },
  subject: row.subject,
  snippet: row.snippet,
  otp: row.otp_code || null,
  receivedAt: row.received_at,
  receivedAtISO: safeIso(row.received_at),
  expiresAt: row.expires_at ?? null,
  expiresAtISO: safeIso(row.expires_at),
  remainingMs: Number.isFinite(Number(row.expires_at))
    ? Math.max(0, Number(row.expires_at) - Date.now())
    : Math.max(0, config.messageTtlMinutes * 60000),
  isRead: !!row.is_read,
  size: row.size,
  hasHtml: !!row.html_body,
  attachments: /* … */ [],
};
```

> ⚠️ ملاحظة مهمة: استعلامات `db.listMessages` / `listMessagesSince` تُرجع حقل
> `expires_at` صريحاً (بدونه ينهار التسلسل بـ `Invalid time value`).

---

## 5) نقاط النهاية (Endpoints)

### `GET /api/health`

```json
{
  "success": true,
  "service": "ظرف (Zarf Mail)",
  "version": "2.0.0",
  "provider": "mailtm",
  "ttlMinutes": { "mailbox": 10080, "message": 10080 },
  "ttlDays":    { "mailbox": 7,     "message": 7     },
  "stats": { "mailboxes": 13, "messages": 2 }
}
```

### `POST /api/generate-email` → `201`

```json
{
  "success": true,
  "message": "تم إنشاء بريدك المؤقت بنجاح 🎉",
  "data": {
    "id": "fkekly94e-xg",
    "address": "ivory_dune_938eb1@emalupe.com",
    "provider": "mailtm",
    "realInbox": true,
    "createdAt": 1788138596746,
    "expiresAt": 1788743396746,
    "expiresAtISO": "2026-09-07T01:09:56.746Z",
    "ttlMinutes": 10080,
    "ttlDays": 7,
    "remainingMs": 604800000,
    "remaining": { "totalMs": 604800000, "days": 7, "hours": 0, "minutes": 0, "seconds": 0, "expired": false },
    "remainingLabel": "7 يوم و 00:00",
    "token": "eyJ…"
  }
}
```

### `GET /api/check-inbox/:emailId?limit=50&sync=1`

```json
{
  "success": true,
  "data": {
    "mailbox": { /* نفس حقول الصندوق أعلاه مع remaining/ttlDays */ },
    "messages": [ { "id": "…", "expiresAt": 1788743603246, "expiresAtISO": "2026-09-07T01:13:23.246Z", "remainingMs": 604152760 } ],
    "unread": 1,
    "sync": { "attempted": true, "synced": true, "added": 1 },
    "serverTime": 1788138800000
  }
}
```

الواجهة تقرأ `mailbox.remaining` و`mailbox.ttlDays` لتعرض العدّاد التنازلي
(`6d 23:59:58`) والملاحظة (`صالح لمدة 7 أيام`).

---

## 6) الحذف التلقائي — `server/services/cleanup.js`

```js
/**
 * عامل التنظيف الدوري
 *   • يحذف كل رسالة مضى عليها messageTtlMinutes (7 أيام)
 *   • يحذف كل صندوق مضى عليه mailboxTtlMinutes (7 أيام)
 *   • مع mail.tm: يحذف النسخة البعيدة أولاً (DELETE /messages/{id} ثم DELETE /accounts/{id})
 *     ضمن ميزانية الطلبات المتاحة، وبطريقة لا تعطّل التنظيف المحلي.
 */

async function purgeRemote() {
  if (config.provider === 'local' || !config.mailtm.deleteOnExpire) return { messages: 0, accounts: 0 };

  let deletedMessages = 0;
  let deletedAccounts = 0;

  // 1) الرسائل المنتهية
  for (const row of db.listExpiredMessages(40)) {
    if (!hasBudget()) break;
    try {
      if (row.provider_id && row.token) {
        await providers.mailtm.deleteMessage({ id: row.mailbox_id, token: row.token, provider_id: row.account_id }, row.provider_id);
        deletedMessages += 1;
      }
    } catch (e) { /* تجاهل */ }
  }

  // 2) الحسابات المنتهية
  for (const row of db.listExpiredMailboxes(20)) {
    if (!hasBudget()) break;
    try {
      if (await providers.mailtm.deleteMailbox(row)) deletedAccounts += 1;
    } catch (e) { /* تجاهل */ }
  }

  if (deletedMessages || deletedAccounts) {
    logger.info(`☁️  حذف من mail.tm: ${deletedMessages} رسالة و ${deletedAccounts} حساب منتهي`);
  }
  return { messages: deletedMessages, accounts: deletedAccounts };
}

async function runCleanup() {
  const report = { localMessages: 0, localMailboxes: 0, remoteMessages: 0, remoteAccounts: 0 };

  // نحذف من الخدمة البعيدة أولاً (قبل فقدان البيانات المحلية!)
  try {
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

  setTimeout(() => runCleanup(), 3000);              // تنظيف أولي بعد الإقلاع
  timer = setInterval(runCleanup, intervalMs);
  if (timer.unref) timer.unref();

  logger.info(`⏱  عامل التنظيف يعمل كل ${config.cleanupIntervalMinutes} دقيقة — يحذف ما تجاوز ${config.mailboxTtlMinutes / 1440} يوم فقط`);
  return timer;
}
```

### قاعدة البيانات — `server/db.js`

```js
  pruneExpired() {
    const now = Date.now();
    const messages = stmts.deleteExpiredMessages.run(now).changes;
    const mailboxes = stmts.deleteExpiredMailboxes.run(now).changes;
    return { messages, mailboxes };
  },
```

(شرط الحذف: `expires_at <= ?` — و`expires_at` يُحسب عند الإنشاء كـ
`Date.now() + ttlMinutes * 60_000`، أي بعد 7 أيام بالضبط.)

---

## 7) سكربت الكرون المستقل — `scripts/cleanup.js`

```bash
# تشغيل يدوي
node scripts/cleanup.js

# كل ساعة عبر Cron
0 * * * * cd /path/to/zarf-mail && /usr/bin/node scripts/cleanup.js >> /var/log/zarf-cleanup.log 2>&1

# أو يومياً في الثالثة فجراً
0 3 * * * cd /path/to/zarf-mail && /usr/bin/node scripts/cleanup.js >> /var/log/zarf-cleanup.log 2>&1
```

مخرجات السكربت:

```
🧹 بدء مهمة التنظيف (Cron)…
   · مدة صلاحية البريد : 10080 دقيقة (7 يوم)
   · مدة صلاحية الرسالة: 10080 دقيقة (7 يوم)
📊 تقرير التنظيف:
   · محلياً  : 0 رسالة و 0 صندوق
   · بعيداً  : 0 رسالة و 0 حساب (mail.tm)
   · الصناديق: 13 → 13
   · الرسائل : 2 → 2
✅ اكتمل التنظيف في 41 ملّي ثانية
```

> السيرفر يشغّل العامل داخلياً أيضاً كل `CLEANUP_INTERVAL_MINUTES` دقيقة،
> والسكربت طبقة إضافية (مفيدة عند تشغيل عدة نسخ، أو على استضافة بدون عمليات دائمة).

---

## 8) هل mail.tm نفسها تحفظ 7 أيام؟ ✅ نعم

استعلام مباشر من الخدمة أظهر أن كل رسالة تحمل:

```json
{ "retention": true, "retentionDate": "2026-09-07T00:50:15+00:00" }
```

أي أن الخدمة تحذف الرسالة بعد **7 أيام بالضبط** من إنشائها — فوعد ظرف مطابق للواقع
على الجانبين (قاعدة ظرف + خدمة mail.tm).

---

## 9) حماية إضافية أُضيفت أثناء التنفيذ

| المشكلة | الحل |
|---|---|
| `serializeMessage` كان يرمي `RangeError: Invalid time value` لأن استعلام القائمة لا يُرجع `expires_at` → الطلب يبقى معلقاً حتى تنفد مهلة المتصفح | أُضيف `expires_at` إلى `listMessages/listMessagesSince` + دالة `safeIso()` + غلاف `asyncRoute()` لكل المعالجات غير المتزامنة (يُرجع 500 JSON بدل التعليق) |
| سباق بين مزامنتين (يدوية + دورية) يُسقط المزامنة بـ `UNIQUE constraint failed` | `storeRemoteMessage` يلتقط الخطأ ويتجاهل الرسالة المكرّرة بصمت |
| وعود معلّقة بلا `.catch` (`markSeen`) تُسجَّل كرفض غير معالَج | `.catch()` صريح + تسجيل المكدّس في معالج `unhandledRejection` |

---

## 10) التحقق السريع

```bash
curl -s http://127.0.0.1:3000/api/health | jq '.ttlDays, .ttlMinutes'
curl -s -X POST http://127.0.0.1:3000/api/generate-email -H 'Content-Type: application/json' -d '{}' \
  | jq '.data | {address, ttlDays, expiresAtISO, remainingLabel, remaining}'
node scripts/cleanup.js
```
