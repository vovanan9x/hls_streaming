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
  `);

  // Migrate existing DB columns
  const migrations = [
    `ALTER TABLE videos ADD COLUMN progress INTEGER DEFAULT 0`,
    `ALTER TABLE videos ADD COLUMN qualities TEXT DEFAULT '["720p"]'`,
    `ALTER TABLE videos ADD COLUMN visibility TEXT DEFAULT 'public'`,
    `ALTER TABLE users ADD COLUMN api_token TEXT DEFAULT NULL`,
  ];
  for (const sql of migrations) {
    try { db.exec(sql); } catch (e) { /* already exists */ }
  }
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

module.exports = { getDb, getSetting, setSetting };
