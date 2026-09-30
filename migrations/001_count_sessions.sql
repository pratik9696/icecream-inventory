-- One-time, additive migration for an EXISTING database (no ALTER/DROP).
-- 1) create the new tables (same DDL as schema.sql), 2) backfill count_log from
-- existing inventory rows so history stays visible. Safe to re-run: the
-- backfill only runs while count_log is empty.
CREATE TABLE IF NOT EXISTS count_sessions (
  date TEXT PRIMARY KEY,
  opened_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE TABLE IF NOT EXISTS count_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  count_date TEXT NOT NULL,
  product TEXT NOT NULL,
  type TEXT NOT NULL,
  manufacturing TEXT NOT NULL,
  stock_before INTEGER,
  counted INTEGER NOT NULL,
  logged_at TEXT NOT NULL,
  in_session INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_count_log_date ON count_log(count_date);
CREATE TABLE IF NOT EXISTS store_loads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  load_date TEXT NOT NULL,
  product TEXT NOT NULL,
  type TEXT NOT NULL,
  manufacturing TEXT NOT NULL,
  qty INTEGER NOT NULL,
  stock_before INTEGER NOT NULL,
  stock_after INTEGER NOT NULL,
  logged_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_store_loads_date ON store_loads(load_date);

INSERT INTO count_log (count_date, product, type, manufacturing, stock_before, counted, logged_at, in_session)
SELECT count_date, product, type, manufacturing, NULL, count, logged_at, 0 FROM inventory
WHERE NOT EXISTS (SELECT 1 FROM count_log);
