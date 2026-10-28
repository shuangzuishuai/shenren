-- 神人榜 · Cloudflare D1 建表语句
-- 在 Cloudflare 控制台 → 存储和数据库 → D1 → 你的数据库 → 控制台，粘贴执行

CREATE TABLE IF NOT EXISTS entries (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  author      TEXT NOT NULL,
  deeds       TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  created_at  INTEGER NOT NULL,
  reviewed_at INTEGER,
  ip_hash     TEXT
);

CREATE INDEX IF NOT EXISTS idx_entries_status ON entries (status, created_at DESC);

CREATE TABLE IF NOT EXISTS rate (
  ip TEXT PRIMARY KEY,
  at INTEGER NOT NULL
);
