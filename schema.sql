-- Ice Cream Inventory - D1 schema
-- A batch is (product, type, manufacturing date). Two deliveries on the same
-- date are the same batch (merge); different dates are separate batches, so
-- the same flavour+type can have multiple rows in flight at once, each with
-- its own expiry and its own daily-count history.

CREATE TABLE IF NOT EXISTS products (
  product TEXT NOT NULL,
  type TEXT NOT NULL,
  manufacturing TEXT NOT NULL,   -- yyyy-mm-dd, part of the batch key
  count INTEGER NOT NULL DEFAULT 1,
  added_on TEXT NOT NULL,        -- ISO timestamp
  status TEXT NOT NULL DEFAULT 'active',   -- 'active' | 'returned' | 'disposed'
  PRIMARY KEY (product, type, manufacturing)
);
-- On an existing database (this column didn't always exist), run instead:
--   ALTER TABLE products ADD COLUMN status TEXT NOT NULL DEFAULT 'active';

CREATE TABLE IF NOT EXISTS inventory (
  product TEXT NOT NULL,
  type TEXT NOT NULL,
  manufacturing TEXT NOT NULL,   -- which batch this count is for
  count_date TEXT NOT NULL,      -- yyyy-mm-dd
  count INTEGER NOT NULL,
  logged_at TEXT NOT NULL,       -- ISO timestamp
  PRIMARY KEY (product, type, manufacturing, count_date)
);

CREATE INDEX IF NOT EXISTS idx_inventory_batch ON inventory(product, type, manufacturing);

-- Daily count sessions: staff "open" the daily count, count every batch, then
-- "close" it. One row per calendar date; closed_at NULL means currently open.
CREATE TABLE IF NOT EXISTS count_sessions (
  date TEXT PRIMARY KEY,         -- yyyy-mm-dd
  opened_at TEXT NOT NULL,
  closed_at TEXT
);

-- One row per daily-count entry (the log). inventory still holds the stock
-- itself; this records what was counted, against what stock, in which session.
-- in_session = 0 marks legacy rows backfilled from inventory - they show in the
-- log but never count as "already counted" in a session.
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

-- One row per store load, so several loads of the same batch on one day are
-- all kept (inventory itself only keeps one row per batch per day).
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
