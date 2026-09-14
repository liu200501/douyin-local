import Database from 'better-sqlite3';
import { config, ensureRuntimeDirs } from './config.js';

ensureRuntimeDirs();

export const db = new Database(config.dbPath);

db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS videos (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    path          TEXT NOT NULL UNIQUE,
    root_dir      TEXT NOT NULL,
    rel_path      TEXT NOT NULL,
    collection    TEXT NOT NULL DEFAULT '',
    filename      TEXT NOT NULL,
    title         TEXT NOT NULL DEFAULT '',
    ext           TEXT NOT NULL,
    size          INTEGER NOT NULL DEFAULT 0,
    mtime         INTEGER NOT NULL DEFAULT 0,
    duration      REAL NOT NULL DEFAULT 0,
    width         INTEGER NOT NULL DEFAULT 0,
    height        INTEGER NOT NULL DEFAULT 0,
    video_codec   TEXT NOT NULL DEFAULT '',
    audio_codec   TEXT NOT NULL DEFAULT '',
    container     TEXT NOT NULL DEFAULT '',
    compat        TEXT NOT NULL DEFAULT 'unknown',
    compat_reason TEXT NOT NULL DEFAULT '',
    play_path     TEXT NOT NULL DEFAULT '',
    poster        TEXT NOT NULL DEFAULT '',
    indexed_at    INTEGER NOT NULL DEFAULT 0,
    missing       INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_videos_collection ON videos(collection);
  CREATE INDEX IF NOT EXISTS idx_videos_mtime ON videos(mtime DESC);
  CREATE INDEX IF NOT EXISTS idx_videos_compat ON videos(compat);

  CREATE TABLE IF NOT EXISTS favorites (
    video_id   INTEGER PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS likes (
    video_id   INTEGER PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS history (
    video_id   INTEGER PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE,
    position   REAL NOT NULL DEFAULT 0,
    duration   REAL NOT NULL DEFAULT 0,
    play_count INTEGER NOT NULL DEFAULT 1,
    played_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tags (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
  );

  CREATE TABLE IF NOT EXISTS video_tags (
    video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    tag_id   INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (video_id, tag_id)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

export const settings = {
  get(key, fallback = undefined) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    if (!row) return fallback;
    try {
      return JSON.parse(row.value);
    } catch {
      return row.value;
    }
  },
  set(key, value) {
    db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run(key, JSON.stringify(value));
    return value;
  },
  all() {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    return Object.fromEntries(
      rows.map((row) => {
        try {
          return [row.key, JSON.parse(row.value)];
        } catch {
          return [row.key, row.value];
        }
      })
    );
  },
};

/** Seed the settings table with the env-provided defaults on first run. */
export function bootstrapSettings() {
  const current = settings.get('videoDirs');
  if (!Array.isArray(current)) {
    settings.set('videoDirs', config.videoDirs);
  }
  if (settings.get('sort') === undefined) {
    settings.set('sort', 'newest');
  }
  if (settings.get('autoplay') === undefined) {
    settings.set('autoplay', true);
  }
  return settings.get('videoDirs', []);
}
