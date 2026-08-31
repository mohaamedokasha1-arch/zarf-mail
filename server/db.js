/**
 * =============================================================
 *  طبقة قاعدة البيانات — ظرف (Zarf Mail)
 * -------------------------------------------------------------
 *  نستخدم SQLite عبر مكتبة better-sqlite3 لأنها:
 *    - ملف واحد خفيف جداً (صفر إعدادات، صفر سيرفر خارجي)
 *    - متزامنة وسريعة جداً (مثالية لهذا النوع من التطبيقات)
 *    - تعمل على أي استضافة مجانية (Render / Railway / VPS)
 *  المخطط (Schema):
 *    mailboxes  : صناديق البريد المؤقتة
 *    messages   : الرسائل الواردة
 *    attachments: مرفقات الرسائل (بيانات وصفية فقط بدون محتوى ثنائي)
 * =============================================================
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');
const logger = require('./lib/logger');

// نضمن وجود مجلد البيانات
fs.mkdirSync(config.paths.dataDir, { recursive: true });

/** إنشاء الاتصال وتفعيل إعدادات الأداء */
const db = new Database(config.paths.dbFile);
db.pragma('journal_mode = WAL');   // كتابة أسرع + قراءة متزامنة
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');    // تفعيل الحذف المتسلسل (CASCADE)
db.pragma('busy_timeout = 5000');

/* ============================ نظام الترقية (Migrations) ============================
   نضيف الأعمدة الجديدة بأمان دون حذف قاعدة قائمة (SQLite لا تدعم ADD COLUMN IF NOT EXISTS)
=================================================================================== */
function addColumnIfMissing(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    logger.info(`🛠  ترقية قاعدة البيانات: أُضيف العمود ${table}.${column}`);
  }
}

/** ================= إنشاء الجداول (إن لم تكن موجودة) ================= */
db.exec(`
  CREATE TABLE IF NOT EXISTS mailboxes (
    id               TEXT PRIMARY KEY,
    address          TEXT NOT NULL UNIQUE,
    local_part       TEXT NOT NULL,
    domain           TEXT NOT NULL,
    token            TEXT NOT NULL,
    created_at       INTEGER NOT NULL,
    expires_at       INTEGER NOT NULL,
    last_accessed_at INTEGER,
    message_count    INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS messages (
    id            TEXT PRIMARY KEY,
    mailbox_id    TEXT NOT NULL,
    message_id    TEXT,
    from_name     TEXT,
    from_address  TEXT,
    to_address    TEXT,
    subject       TEXT,
    text_body     TEXT,
    html_body     TEXT,
    snippet       TEXT,
    otp_code      TEXT,
    otp_context   TEXT,
    received_at   INTEGER NOT NULL,
    expires_at    INTEGER NOT NULL,
    is_read       INTEGER NOT NULL DEFAULT 0,
    size          INTEGER NOT NULL DEFAULT 0,
    raw_headers   TEXT,
    FOREIGN KEY (mailbox_id) REFERENCES mailboxes(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS attachments (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id   TEXT NOT NULL,
    filename     TEXT,
    content_type TEXT,
    size         INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_mailboxes_expires  ON mailboxes(expires_at);
  CREATE INDEX IF NOT EXISTS idx_messages_mailbox   ON messages(mailbox_id, received_at DESC);
  CREATE INDEX IF NOT EXISTS idx_messages_expires   ON messages(expires_at);
  CREATE INDEX IF NOT EXISTS idx_attachments_msg    ON attachments(message_id);
`);

/* ---------------- أعمدة مزوّد الخدمة (mail.tm وغيره) ---------------- */
addColumnIfMissing('mailboxes', 'provider', "TEXT NOT NULL DEFAULT 'local'");
addColumnIfMissing('mailboxes', 'provider_id', 'TEXT');        // معرّف الحساب لدى الخدمة
addColumnIfMissing('mailboxes', 'password', 'TEXT');           // كلمة مرور الحساب المؤقت
addColumnIfMissing('mailboxes', 'token', 'TEXT');              // توكن الجلسة (JWT)
addColumnIfMissing('mailboxes', 'last_synced_at', 'INTEGER');  // آخر مزامنة مع الخدمة
addColumnIfMissing('mailboxes', 'sync_error', 'TEXT');         // آخر خطأ مزامنة
addColumnIfMissing('messages', 'provider', "TEXT NOT NULL DEFAULT 'local'");
addColumnIfMissing('messages', 'provider_id', 'TEXT');         // معرّف الرسالة لدى الخدمة

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_mailboxes_provider ON mailboxes(provider, last_synced_at);
  CREATE INDEX IF NOT EXISTS idx_mailboxes_active   ON mailboxes(last_accessed_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_provider_id
    ON messages(mailbox_id, provider_id) WHERE provider_id IS NOT NULL;
`);

/* ======================= العبارات المحضّرة (Prepared Statements) ======================= */
const stmts = {
  insertMailbox: db.prepare(`
    INSERT INTO mailboxes (
      id, address, local_part, domain, token, created_at, expires_at, last_accessed_at, message_count,
      provider, provider_id, password, last_synced_at
    ) VALUES (
      @id, @address, @localPart, @domain, @token, @createdAt, @expiresAt, @createdAt, 0,
      @provider, @providerId, @password, @lastSyncedAt
    )
  `),
  getMailboxById: db.prepare(`SELECT * FROM mailboxes WHERE id = ?`),
  getMailboxByAddress: db.prepare(`SELECT * FROM mailboxes WHERE address = ?`),
  touchMailbox: db.prepare(`UPDATE mailboxes SET last_accessed_at = ? WHERE id = ?`),
  bumpMessageCount: db.prepare(`UPDATE mailboxes SET message_count = message_count + 1 WHERE id = ?`),
  deleteMailbox: db.prepare(`DELETE FROM mailboxes WHERE id = ?`),

  insertMessage: db.prepare(`
    INSERT INTO messages (
      id, mailbox_id, message_id, from_name, from_address, to_address,
      subject, text_body, html_body, snippet, otp_code, otp_context,
      received_at, expires_at, is_read, size, raw_headers, provider, provider_id
    ) VALUES (
      @id, @mailboxId, @messageId, @fromName, @fromAddress, @toAddress,
      @subject, @textBody, @htmlBody, @snippet, @otpCode, @otpContext,
      @receivedAt, @expiresAt, 0, @size, @rawHeaders, @provider, @providerId
    )
  `),
  insertAttachment: db.prepare(`
    INSERT INTO attachments (message_id, filename, content_type, size)
    VALUES (?, ?, ?, ?)
  `),
  listMessages: db.prepare(`
    SELECT id, from_name, from_address, subject, snippet, otp_code,
           received_at, expires_at, is_read, size
    FROM messages
    WHERE mailbox_id = ? AND expires_at > ?
    ORDER BY received_at DESC
    LIMIT ? OFFSET ?
  `),
  listMessagesSince: db.prepare(`
    SELECT id, from_name, from_address, subject, snippet, otp_code,
           received_at, expires_at, is_read, size
    FROM messages
    WHERE mailbox_id = ? AND expires_at > ? AND received_at > ?
    ORDER BY received_at DESC
    LIMIT ?
  `),
  getMessage: db.prepare(`
    SELECT * FROM messages WHERE id = ? AND mailbox_id = ? AND expires_at > ?
  `),
  getAttachments: db.prepare(`SELECT filename, content_type, size FROM attachments WHERE message_id = ?`),
  markRead: db.prepare(`UPDATE messages SET is_read = 1 WHERE id = ? AND mailbox_id = ?`),
  markAllRead: db.prepare(`UPDATE messages SET is_read = 1 WHERE mailbox_id = ?`),
  deleteMessage: db.prepare(`DELETE FROM messages WHERE id = ? AND mailbox_id = ?`),
  countMessages: db.prepare(`SELECT COUNT(*) AS c FROM messages WHERE mailbox_id = ? AND expires_at > ?`),
  oldestMessages: db.prepare(`
    SELECT id FROM messages WHERE mailbox_id = ? ORDER BY received_at ASC LIMIT ?
  `),
  deleteMessagesByIds: db.prepare(`DELETE FROM messages WHERE id = ?`),

  deleteExpiredMailboxes: db.prepare(`DELETE FROM mailboxes WHERE expires_at <= ?`),
  deleteExpiredMessages: db.prepare(`DELETE FROM messages WHERE expires_at <= ?`),
  countMailboxes: db.prepare(`SELECT COUNT(*) AS c FROM mailboxes`),
  countAllMessages: db.prepare(`SELECT COUNT(*) AS c FROM messages`),

  /* ===== استعلامات خاصة بمزوّد البريد (mail.tm) ===== */
  // عدد الصناديق النشطة (لحساب الفاصل التكيّفي للمزامنة)
  countActiveMailboxes: db.prepare(`
    SELECT COUNT(*) AS c FROM mailboxes
    WHERE provider = ? AND expires_at > ? AND last_accessed_at >= ?
  `),
  // الصناديق النشطة (صاحبها فتحها مؤخراً) الأحقّ بالمزامنة أولاً
  listSyncCandidates: db.prepare(`
    SELECT * FROM mailboxes
    WHERE provider = ? AND expires_at > ? AND last_accessed_at >= ?
    ORDER BY COALESCE(last_synced_at, 0) ASC
    LIMIT ?
  `),
  updateSyncState: db.prepare(`
    UPDATE mailboxes SET last_synced_at = ?, sync_error = ? WHERE id = ?
  `),
  updateToken: db.prepare(`UPDATE mailboxes SET token = ? WHERE id = ?`),
  findMessageByProviderId: db.prepare(`
    SELECT id FROM messages WHERE mailbox_id = ? AND provider_id = ?
  `),
  // الرسائل المنتهية صلاحيتها (لحذفها من الخدمة البعيدة أيضاً)
  listExpiredMessages: db.prepare(`
    SELECT m.id, m.mailbox_id, m.provider, m.provider_id, mb.token, mb.provider_id AS account_id
    FROM messages m JOIN mailboxes mb ON mb.id = m.mailbox_id
    WHERE m.expires_at <= ? AND m.provider_id IS NOT NULL
    LIMIT ?
  `),
  // الحسابات المنتهية (لحذفها من الخدمة البعيدة)
  listExpiredMailboxes: db.prepare(`
    SELECT id, provider, provider_id, token FROM mailboxes
    WHERE expires_at <= ? AND provider != 'local' AND provider_id IS NOT NULL
    LIMIT ?
  `),
};

/* ============================ واجهة التعامل مع قاعدة البيانات ============================ */
const repo = {
  /** المقبض الخام (للاستخدامات المتقدمة) */
  raw: db,

  /** ---------- صناديق البريد ---------- */
  createMailbox(data) {
    stmts.insertMailbox.run(data);
    return stmts.getMailboxById.get(data.id);
  },
  getMailboxById: (id) => stmts.getMailboxById.get(id),
  getMailboxByAddress: (address) => stmts.getMailboxByAddress.get(address),
  touchMailbox(id) {
    stmts.touchMailbox.run(Date.now(), id);
  },

  /** ---------- الرسائل ---------- */
  insertMessage(data) {
    return db.transaction((payload) => {
      stmts.insertMessage.run(payload);
      stmts.bumpMessageCount.run(payload.mailboxId);

      // إدخال المرفقات (بيانات وصفية فقط — لا نخزّن الملفات نفسها حفاظاً على الخصوصية)
      if (Array.isArray(payload.attachments)) {
        for (const att of payload.attachments) {
          stmts.insertAttachment.run(
            payload.id,
            String(att.filename || 'attachment').slice(0, 200),
            String(att.contentType || 'application/octet-stream').slice(0, 150),
            Number(att.size || 0)
          );
        }
      }

      // الحفاظ على حد أقصى لعدد الرسائل في كل صندوق (حذف الأقدم)
      const total = stmts.countMessages.get(payload.mailboxId, Date.now()).c;
      if (total > config.maxMessagesPerMailbox) {
        const extra = stmts.oldestMessages.all(payload.mailboxId, total - config.maxMessagesPerMailbox);
        for (const row of extra) stmts.deleteMessagesByIds.run(row.id);
      }
      return payload.id;
    })(data);
  },

  listMessages(mailboxId, { limit = 50, offset = 0, since = 0 } = {}) {
    const now = Date.now();
    if (since > 0) {
      return stmts.listMessagesSince.all(mailboxId, now, Number(since), limit);
    }
    return stmts.listMessages.all(mailboxId, now, limit, offset);
  },

  getMessage(messageId, mailboxId) {
    const message = stmts.getMessage.get(messageId, mailboxId, Date.now());
    if (!message) return null;
    message.attachments = stmts.getAttachments.all(messageId);
    return message;
  },

  markRead(messageId, mailboxId) {
    stmts.markRead.run(messageId, mailboxId);
  },
  markAllRead(mailboxId) {
    stmts.markAllRead.run(mailboxId);
  },
  deleteMessage(messageId, mailboxId) {
    return stmts.deleteMessage.run(messageId, mailboxId).changes > 0;
  },
  countMessages(mailboxId) {
    return stmts.countMessages.get(mailboxId, Date.now()).c;
  },

  /** حذف صندوق بريد وكل ما يتبعه (بفضل ON DELETE CASCADE) */
  deleteMailbox(id) {
    return stmts.deleteMailbox.run(id).changes > 0;
  },

  /** تنظيف كل ما انتهت صلاحيته */
  pruneExpired() {
    const now = Date.now();
    const messages = stmts.deleteExpiredMessages.run(now).changes;
    const mailboxes = stmts.deleteExpiredMailboxes.run(now).changes;
    return { messages, mailboxes };
  },

  /* ---------- مزامنة المزوّد الخارجي ---------- */

  /** الصناديق المؤهلة للمزامنة الآن (الأقل مزامنةً أولاً) */
  listSyncCandidates(provider, activeSince, limit) {
    return stmts.listSyncCandidates.all(provider, Date.now(), activeSince, limit);
  },
  /** عدد الصناديق النشطة (تستخدم لحساب الفاصل التكيّفي) */
  countActiveMailboxes(provider, activeSince) {
    return stmts.countActiveMailboxes.get(provider, Date.now(), activeSince).c;
  },
  markSynced(id, error = null) {
    stmts.updateSyncState.run(Date.now(), error ? String(error).slice(0, 200) : null, id);
  },
  setToken(id, token) {
    stmts.updateToken.run(token, id);
  },
  /** هل الرسالة مخزّنة محلياًalready؟ (يمنع التكرار عند كل مزامنة) */
  hasProviderMessage(mailboxId, providerId) {
    if (!providerId) return false;
    return !!stmts.findMessageByProviderId.get(mailboxId, providerId);
  },
  /** الرسائل المنتهية مع بيانات الحساب البعيد (للحذف من الخدمة) */
  listExpiredMessages(limit = 50) {
    return stmts.listExpiredMessages.all(Date.now(), limit);
  },
  /** الحسابات المنتهية (للحذف من الخدمة) */
  listExpiredMailboxes(limit = 30) {
    return stmts.listExpiredMailboxes.all(Date.now(), limit);
  },

  /** إحصائيات سريعة (تظهر في /api/health) */
  stats() {
    return {
      mailboxes: stmts.countMailboxes.get().c,
      messages: stmts.countAllMessages.get().c,
    };
  },
};

logger.success(`قاعدة البيانات جاهزة: ${path.relative(config.paths.root, config.paths.dbFile)}`);

module.exports = repo;
