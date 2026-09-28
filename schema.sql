-- Ice Cream Inventory - D1 schema
-- Mirrors the invariants already enforced by hand in the Apps Script backend:
--   one row per product+type (Products), one row per product+type per day (Inventory)

CREATE TABLE IF NOT EXISTS products (
  product TEXT NOT NULL,
  type TEXT NOT NULL,
  manufacturing TEXT NOT NULL,   -- yyyy-mm-dd
  count INTEGER NOT NULL DEFAULT 1,
  added_on TEXT NOT NULL,        -- ISO timestamp
  PRIMARY KEY (product, type)
);

CREATE TABLE IF NOT EXISTS inventory (
  product TEXT NOT NULL,
  type TEXT NOT NULL,
  count_date TEXT NOT NULL,      -- yyyy-mm-dd
  count INTEGER NOT NULL,
  logged_at TEXT NOT NULL,       -- ISO timestamp
  PRIMARY KEY (product, type, count_date)
);

CREATE INDEX IF NOT EXISTS idx_inventory_product_type ON inventory(product, type);
