const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');

const DB_PATH = path.join(__dirname, 'data', 'streaming.db');
let db;

function getDb() {
  if (!db) {
    const fs = require('fs');
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initTables();
    seedDefaultAdmin();
  }
  return db;
}

function initTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      display_name TEXT DEFAULT '',
      role TEXT NOT NULL DEFAULT 'uploader',
      is_active INTEGER DEFAULT 1,
      api_token TEXT DEFAULT NULL,
      created_at DATETIME DEFAULT (datetime('now','localtime')),
      updated_at DATETIME DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS servers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL,
      ip TEXT NOT NULL,
      port INTEGER DEFAULT 22,
      username TEXT NOT NULL,
      password TEXT DEFAULT '',
      storage_path TEXT DEFAULT '/var/hls-storage',
      is_active INTEGER DEFAULT 1,
      status TEXT DEFAULT 'unknown',
      last_checked DATETIME,
      created_at DATETIME DEFAULT (datetime('now','localtime')),
      updated_at DATETIME DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS videos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      thumbnail TEXT DEFAULT '',
      video_file TEXT DEFAULT '',
      m3u8_url TEXT DEFAULT '',
      iframe_url TEXT DEFAULT '',
      server_id INTEGER,
      uploaded_by INTEGER,
      status TEXT DEFAULT 'processing',
      progress INTEGER DEFAULT 0,
      qualities TEXT DEFAULT '["720p"]',
      visibility TEXT DEFAULT 'public',
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT (datetime('now','localtime')),
      updated_at DATETIME DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE SET NULL,
      FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at DATETIME DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS view_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id INTEGER NOT NULL,
      session_key TEXT NOT NULL,
      ip TEXT DEFAULT '',
      started_at DATETIME DEFAULT (datetime('now','localtime')),
      last_ping DATETIME DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS error_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL DEFAULT 'unknown',
      video_id INTEGER DEFAULT NULL,
      video_title TEXT DEFAULT '',
      server_id INTEGER DEFAULT NULL,
      server_label TEXT DEFAULT '',
      message TEXT NOT NULL,
      stack TEXT DEFAULT '',
      created_at DATETIME DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS delete_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id INTEGER NOT NULL,
      video_title TEXT DEFAULT '',
      requested_by INTEGER NOT NULL,
      reason TEXT DEFAULT '',
      status TEXT DEFAULT 'pending',
      reviewed_by INTEGER DEFAULT NULL,
      created_at DATETIME DEFAULT (datetime('now','localtime')),
      reviewed_at DATETIME DEFAULT NULL,
      FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE,
      FOREIGN KEY (requested_by) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS cdn_domains (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      label         TEXT DEFAULT '',
      domain        TEXT NOT NULL UNIQUE,
      server_id     INTEGER REFERENCES servers(id) ON DELETE SET NULL,
      cf_email      TEXT DEFAULT '',
      cf_api_token  TEXT DEFAULT '',
      cf_zone_id    TEXT DEFAULT '',
      is_active     INTEGER DEFAULT 1,
      note          TEXT DEFAULT '',
      created_at    DATETIME DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS cf_create_jobs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      domain     TEXT NOT NULL,
      server_id  INTEGER DEFAULT NULL,
      status     TEXT DEFAULT 'pending',
      log        TEXT DEFAULT '[]',
      created_at DATETIME DEFAULT (datetime('now','localtime'))
    );
  `);

  // Migrate existing DB columns
  const migrations = [
    `ALTER TABLE videos ADD COLUMN progress INTEGER DEFAULT 0`,
    `ALTER TABLE videos ADD COLUMN qualities TEXT DEFAULT '["720p"]'`,
    `ALTER TABLE videos ADD COLUMN visibility TEXT DEFAULT 'public'`,
    `ALTER TABLE users ADD COLUMN api_token TEXT DEFAULT NULL`,
    // Server type support: sftp (default) or r2
    `ALTER TABLE servers ADD COLUMN server_type TEXT DEFAULT 'sftp'`,
    `ALTER TABLE servers ADD COLUMN r2_account_id TEXT DEFAULT ''`,
    `ALTER TABLE servers ADD COLUMN r2_access_key TEXT DEFAULT ''`,
    `ALTER TABLE servers ADD COLUMN r2_secret_key TEXT DEFAULT ''`,
    `ALTER TABLE servers ADD COLUMN r2_bucket TEXT DEFAULT ''`,
    `ALTER TABLE servers ADD COLUMN r2_public_url TEXT DEFAULT ''`,
    `ALTER TABLE servers ADD COLUMN cdn_url TEXT DEFAULT ''`,
  ];
  for (const sql of migrations) {
    try { db.exec(sql); } catch (e) { /* already exists */ }
  }

  // ── Performance Indexes ──
  db.exec(`
    -- videos: thường query theo status, server_id, uploaded_by, visibility, sort_order
    CREATE INDEX IF NOT EXISTS idx_videos_status ON videos(status);
    CREATE INDEX IF NOT EXISTS idx_videos_server_id ON videos(server_id);
    CREATE INDEX IF NOT EXISTS idx_videos_uploaded_by ON videos(uploaded_by);
    CREATE INDEX IF NOT EXISTS idx_videos_visibility ON videos(visibility);
    CREATE INDEX IF NOT EXISTS idx_videos_sort_order ON videos(sort_order DESC);
    CREATE INDEX IF NOT EXISTS idx_videos_created_at ON videos(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_videos_status_sort ON videos(status, sort_order DESC);

    -- view_logs: analytics queries dùng video_id, session_key, last_ping
    CREATE INDEX IF NOT EXISTS idx_view_logs_video_id ON view_logs(video_id);
    CREATE INDEX IF NOT EXISTS idx_view_logs_session_key ON view_logs(session_key);
    CREATE INDEX IF NOT EXISTS idx_view_logs_last_ping ON view_logs(last_ping);
    CREATE INDEX IF NOT EXISTS idx_view_logs_video_session ON view_logs(video_id, session_key);

    -- error_logs: filter theo type, sắp xếp theo created_at
    CREATE INDEX IF NOT EXISTS idx_error_logs_type ON error_logs(type);
    CREATE INDEX IF NOT EXISTS idx_error_logs_created_at ON error_logs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_error_logs_video_id ON error_logs(video_id);

    -- delete_requests: filter theo status, video_id
    CREATE INDEX IF NOT EXISTS idx_delete_requests_status ON delete_requests(status);
    CREATE INDEX IF NOT EXISTS idx_delete_requests_video_id ON delete_requests(video_id);

    -- cdn_domains: lookup theo server_id, is_active
    CREATE INDEX IF NOT EXISTS idx_cdn_domains_server_id ON cdn_domains(server_id);
    CREATE INDEX IF NOT EXISTS idx_cdn_domains_active ON cdn_domains(is_active);

    -- users: API token lookup
    CREATE INDEX IF NOT EXISTS idx_users_api_token ON users(api_token);

    -- servers: active filter
    CREATE INDEX IF NOT EXISTS idx_servers_active ON servers(is_active);

    -- cf_create_jobs: status filter
    CREATE INDEX IF NOT EXISTS idx_cf_jobs_status ON cf_create_jobs(status);
  `);
}

function seedDefaultAdmin() {
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
  if (!existing) {
    const hash = bcrypt.hashSync('admin123', 10);
    db.prepare(`INSERT INTO users (username, password, display_name, role) VALUES (?, ?, ?, ?)`)
      .run('admin', hash, 'Administrator', 'administrator');
    console.log('[DB] Default admin created — username: admin, password: admin123');
  }
}

function getSetting(key, defaultValue = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : defaultValue;
}

function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now','localtime'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, String(value));
}

/**
 * Ghi một lỗi vào bảng error_logs
 * @param {'encode'|'upload'|'thumb'|'sftp'|'r2'|'unknown'} type
 * @param {object} opts - { videoId, videoTitle, serverId, serverLabel, message, stack }
 */
function addErrorLog(type, opts = {}) {
  try {
    const d = getDb();
    d.prepare(`
      INSERT INTO error_logs (type, video_id, video_title, server_id, server_label, message, stack)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      type,
      opts.videoId || null,
      opts.videoTitle || '',
      opts.serverId || null,
      opts.serverLabel || '',
      String(opts.message || '').substring(0, 2000),
      String(opts.stack || '').substring(0, 4000)
    );
  } catch (e) {
    console.error('[ErrorLog] Failed to insert log:', e.message);
  }
}

module.exports = { getDb, getSetting, setSetting, addErrorLog };
