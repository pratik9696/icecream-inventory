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
  PRIMARY KEY (product, type, manufacturing)
);

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
