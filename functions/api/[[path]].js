/**
 * Ice Cream Inventory - Cloudflare Pages Function backend.
 * D1 is the primary source of truth (fast, indexed). Every successful write
 * is also relayed, best-effort and non-blocking, to the existing Apps Script
 * web app so the Google Sheet + its native Dashboard tab keep working too.
 *
 * A "batch" is (product, type, manufacturing date). The same flavour+type
 * can have multiple batches in flight at once - a new manufacturing date
 * creates a new row rather than overwriting the existing one; the exact same
 * triple updates in place (two deliveries on the same date are one batch).
 * Daily counts are logged per batch, so live stock and expiry are per batch.
 */

// ---- CONFIG ------------------------------------------------------------
const TYPES = ['Mini Pack', 'Family Pack'];
const FLAVOURS = [
  'Sitafal', 'Mango', 'Tender Coconut', 'Strawberry', 'Chilli Guava', 'Jamun', 'Chikoo', 'Jackfruits',
  'Blue Berry', 'Black Currant', 'Lychee', 'Candied Fruits', 'Muskmelon', 'Roasted Almond', 'Rajbhog',
  'Anjir', 'Coffee Walnut', 'Choco Almond', 'Chocolate', 'Chocochips', 'Dalgona Coffee', 'Vanilla',
  'Butterscotch', 'Biscoff', 'Oreo', 'Mango SF', 'Chocolate SF'
];
// --------------------------------------------------------------------------

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'content-type': 'application/json' }
  });
}

function clean(s) {
  return String(s || '').trim().replace(/\s+/g, ' ');
}

// yyyy-mm-dd strings sort lexicographically same as chronologically. Allow
// a 1-day grace window past the server's UTC "today" so a legitimate local
// "today" entered in a timezone ahead of UTC (e.g. IST) isn't rejected.
function isTooFarInFuture(dateStr) {
  const max = new Date();
  max.setUTCDate(max.getUTCDate() + 1);
  return dateStr > max.toISOString().slice(0, 10);
}

function checkAuth(env, key) {
  const passcode = env.PASSCODE || '';
  if (passcode && key !== passcode) throw new Error('unauthorized');
}

// batch key: a flavour+type can have several rows in flight at once (one per
// manufacturing date), so every lookup/upsert is keyed on all three fields.
const SEP = '';
const batchKey = (product, type, manufacturing) => product + SEP + type + SEP + manufacturing;

// authoritative stock for one batch: latest logged count, else the inward count
async function batchInfo(env, product, type, manufacturing) {
  const prod = await env.DB.prepare('SELECT count, status FROM products WHERE product = ? AND type = ? AND manufacturing = ?')
    .bind(product, type, manufacturing).first();
  if (!prod) return null;
  const latest = await env.DB.prepare(
    'SELECT count, count_date FROM inventory WHERE product = ? AND type = ? AND manufacturing = ? ORDER BY count_date DESC LIMIT 1'
  ).bind(product, type, manufacturing).first();
  return {
    stock: latest ? latest.count : prod.count,
    status: prod.status || 'active',
    inwardCount: prod.count,
    latestDate: latest ? latest.count_date : null
  };
}

const UPSERT_INVENTORY = `
  INSERT INTO inventory (product, type, manufacturing, count_date, count, logged_at) VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(product, type, manufacturing, count_date) DO UPDATE SET count = excluded.count, logged_at = excluded.logged_at
`;

const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

async function buildSnapshot(env) {
  const { results: productRows } = await env.DB.prepare(
    'SELECT product, type, manufacturing, count, status FROM products ORDER BY added_on DESC'
  ).all();

  const { results: latestRows } = await env.DB.prepare(`
    SELECT i1.product, i1.type, i1.manufacturing, i1.count
    FROM inventory i1
    WHERE i1.count_date = (
      SELECT MAX(i2.count_date) FROM inventory i2
      WHERE i2.product = i1.product AND i2.type = i1.type AND i2.manufacturing = i1.manufacturing
    )
  `).all();
  const latestMap = new Map(latestRows.map(r => [batchKey(r.product, r.type, r.manufacturing), r.count]));

  const products = productRows.map(r => {
    const key = batchKey(r.product, r.type, r.manufacturing);
    return {
      product: r.product,
      type: r.type,
      manufacturing: r.manufacturing,
      count: r.count,
      status: r.status || 'active',
      stock: latestMap.has(key) ? latestMap.get(key) : r.count
    };
  });

  // every entry from the last 2 days (covers the client's local "today" in any
  // timezone) plus the 15 latest overall, so a busy day is never truncated
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - 2);
  const since = cutoff.toISOString().slice(0, 10);

  const { results: counts } = await env.DB.prepare(`
    SELECT id, count_date AS date, product, type, manufacturing, stock_before, counted AS count, in_session
    FROM count_log
    WHERE count_date >= ? OR id IN (SELECT id FROM count_log ORDER BY count_date DESC, id DESC LIMIT 15)
    ORDER BY count_date DESC, id DESC
  `).bind(since).all();

  const { results: storeLoads } = await env.DB.prepare(`
    SELECT id, load_date AS date, product, type, manufacturing, qty, stock_before, stock_after
    FROM store_loads
    WHERE load_date >= ? OR id IN (SELECT id FROM store_loads ORDER BY load_date DESC, id DESC LIMIT 15)
    ORDER BY load_date DESC, id DESC
  `).bind(since).all();

  const { results: sessions } = await env.DB.prepare(
    'SELECT date, opened_at, closed_at FROM count_sessions ORDER BY date DESC LIMIT 7'
  ).all();

  return { types: TYPES, flavours: FLAVOURS, products, counts, storeLoads, sessions };
}

// best-effort mirror into the existing Apps Script + Google Sheet; never blocks
// or fails the user-facing response. Uses its own LEGACY_PASSCODE (matching
// Code.gs's PASSCODE) rather than the browser's key, so the relay keeps
// authenticating even if the app-facing passcode is disabled or different.
async function relayToLegacy(env, rawBody) {
  if (!env.LEGACY_SCRIPT_URL) return;
  try {
    const body = typeof rawBody === 'string' ? JSON.parse(rawBody) : Object.assign({}, rawBody);
    body.key = env.LEGACY_PASSCODE || '';
    await fetch(env.LEGACY_SCRIPT_URL, { method: 'POST', body: JSON.stringify(body) });
  } catch (err) {
    console.error('Sheet mirror failed:', err);
  }
}

export async function onRequestGet(context) {
  const { request, env } = context;
  try {
    const key = new URL(request.url).searchParams.get('key') || '';
    checkAuth(env, key);
    const snapshot = await buildSnapshot(env);
    return json(Object.assign({ ok: true }, snapshot));
  } catch (err) {
    return json({ ok: false, error: String(err.message || err) });
  }
}

export async function onRequestPost(context) {
  const { request, env, waitUntil } = context;
  const rawBody = await request.text();
  try {
    const b = JSON.parse(rawBody);
    checkAuth(env, b.key);

    if (b.action === 'addProduct') {
      const name = clean(b.product);
      if (!name || !b.type || !b.manufacturing) throw new Error('Product, type and manufacturing date are required');
      if (TYPES.indexOf(b.type) < 0) throw new Error('Unknown type');
      if (FLAVOURS.indexOf(name) < 0) throw new Error('Unknown flavour');
      if (isTooFarInFuture(b.manufacturing)) throw new Error('Manufacturing date cannot be in the future');

      const existing = await env.DB.prepare('SELECT count FROM products WHERE product = ? AND type = ? AND manufacturing = ?')
        .bind(name, b.type, b.manufacturing).first();

      let cnt;
      if (b.count === '' || b.count == null) {
        // blank count on an existing batch means "leave it as-is", not "reset to 1"
        cnt = existing ? existing.count : 1;
      } else {
        cnt = Number(b.count);
        if (!Number.isInteger(cnt) || cnt < 1) throw new Error('Count must be a whole number, 1 or more');
      }

      if (existing) {
        await env.DB.prepare('UPDATE products SET count = ? WHERE product = ? AND type = ? AND manufacturing = ?')
          .bind(cnt, name, b.type, b.manufacturing).run();
        waitUntil(relayToLegacy(env, rawBody));
        return json(Object.assign({ ok: true, message: 'Batch count updated' }, await buildSnapshot(env)));
      }
      await env.DB.prepare('INSERT INTO products (product, type, manufacturing, count, added_on) VALUES (?, ?, ?, ?, ?)')
        .bind(name, b.type, b.manufacturing, cnt, new Date().toISOString()).run();
      waitUntil(relayToLegacy(env, rawBody));
      return json(Object.assign({ ok: true, message: 'Product added' }, await buildSnapshot(env)));
    }

    if (b.action === 'deleteProduct') {
      const name = clean(b.product);
      if (!name || !b.type || !b.manufacturing) throw new Error('Product, type and manufacturing date are required');
      const res = await env.DB.prepare('DELETE FROM products WHERE product = ? AND type = ? AND manufacturing = ?')
        .bind(name, b.type, b.manufacturing).run();
      if (!res.meta.changes) throw new Error('Product not found');
      waitUntil(relayToLegacy(env, rawBody));
      return json(Object.assign({ ok: true, message: 'Product deleted' }, await buildSnapshot(env)));
    }

    if (b.action === 'setBatchStatus') {
      const name = clean(b.product);
      if (!name || !b.type || !b.manufacturing) throw new Error('Product, type and manufacturing date are required');
      if (['active', 'returned', 'disposed'].indexOf(b.status) < 0) throw new Error('Unknown status');
      const res = await env.DB.prepare('UPDATE products SET status = ? WHERE product = ? AND type = ? AND manufacturing = ?')
        .bind(b.status, name, b.type, b.manufacturing).run();
      if (!res.meta.changes) throw new Error('Product not found');
      waitUntil(relayToLegacy(env, rawBody));
      return json(Object.assign({ ok: true, message: 'Marked ' + b.status }, await buildSnapshot(env)));
    }

    if (b.action === 'openCount' || b.action === 'closeCount') {
      if (!isDate(b.date)) throw new Error('Date is required');
      if (isTooFarInFuture(b.date)) throw new Error('Count date cannot be in the future');
      const session = await env.DB.prepare('SELECT closed_at FROM count_sessions WHERE date = ?').bind(b.date).first();
      const now = new Date().toISOString();
      if (b.action === 'openCount') {
        if (session && !session.closed_at) throw new Error('Daily count is already open');
        if (session) await env.DB.prepare('UPDATE count_sessions SET closed_at = NULL WHERE date = ?').bind(b.date).run();
        else await env.DB.prepare('INSERT INTO count_sessions (date, opened_at) VALUES (?, ?)').bind(b.date, now).run();
        return json(Object.assign({ ok: true, message: 'Daily count opened' }, await buildSnapshot(env)));
      }
      if (!session || session.closed_at) throw new Error('Daily count is not open');
      await env.DB.prepare('UPDATE count_sessions SET closed_at = ? WHERE date = ?').bind(now, b.date).run();
      return json(Object.assign({ ok: true, message: 'Daily count closed' }, await buildSnapshot(env)));
    }

    if (b.action === 'addCount') {
      const name = clean(b.product);
      const count = Number(b.count);
      if (!name || !b.type || !b.manufacturing || !b.date || b.count === '' || !(count >= 0)) throw new Error('Product, type, batch, date and count are required');
      if (!Number.isInteger(count)) throw new Error('Count must be a whole number');
      if (isTooFarInFuture(b.date)) throw new Error('Count date cannot be in the future');
      const info = await batchInfo(env, name, b.type, b.manufacturing);
      if (!info) throw new Error('Add ' + name + ' (' + b.type + ') under Products first');
      if (info.status !== 'active') throw new Error('This batch is ' + info.status + ' and can no longer be counted');

      const session = await env.DB.prepare('SELECT closed_at FROM count_sessions WHERE date = ?').bind(b.date).first();
      if (!session || session.closed_at) throw new Error('Daily count is not open - open it first');

      const already = await env.DB.prepare(
        'SELECT 1 FROM count_log WHERE count_date = ? AND product = ? AND type = ? AND manufacturing = ? AND in_session = 1'
      ).bind(b.date, name, b.type, b.manufacturing).first();
      if (already) throw new Error('This batch is already counted in today\'s daily count - delete that entry to recount');

      if (count > info.stock) throw new Error('Incorrect count - ' + count + ' is higher than current inventory (' + info.stock + '). Inward needs to be updated.');

      const now = new Date().toISOString();
      await env.DB.batch([
        env.DB.prepare('INSERT INTO count_log (count_date, product, type, manufacturing, stock_before, counted, logged_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .bind(b.date, name, b.type, b.manufacturing, info.stock, count, now),
        env.DB.prepare(UPSERT_INVENTORY).bind(name, b.type, b.manufacturing, b.date, count, now)
      ]);
      waitUntil(relayToLegacy(env, rawBody));
      return json(Object.assign({ ok: true, message: 'Count saved' }, await buildSnapshot(env)));
    }

    if (b.action === 'deleteCount') {
      const id = Number(b.id);
      if (!Number.isInteger(id)) throw new Error('Count entry is required');
      const row = await env.DB.prepare('SELECT * FROM count_log WHERE id = ?').bind(id).first();
      if (!row) throw new Error('Count entry not found');

      const laterLoad = await env.DB.prepare(
        'SELECT 1 FROM store_loads WHERE product = ? AND type = ? AND manufacturing = ? AND load_date = ? AND logged_at > ?'
      ).bind(row.product, row.type, row.manufacturing, row.count_date, row.logged_at).first();
      if (laterLoad) throw new Error('A store load was recorded after this count - undo that store load first');

      // what the batch's stock would be with no row for this date
      const prev = await env.DB.prepare(
        'SELECT count FROM inventory WHERE product = ? AND type = ? AND manufacturing = ? AND count_date < ? ORDER BY count_date DESC LIMIT 1'
      ).bind(row.product, row.type, row.manufacturing, row.count_date).first();
      const prod = await env.DB.prepare('SELECT count FROM products WHERE product = ? AND type = ? AND manufacturing = ?')
        .bind(row.product, row.type, row.manufacturing).first();
      const base = prev ? prev.count : (prod ? prod.count : null);

      const delLog = env.DB.prepare('DELETE FROM count_log WHERE id = ?').bind(id);
      if (row.stock_before == null || base == null || row.stock_before === base) {
        await env.DB.batch([
          delLog,
          env.DB.prepare('DELETE FROM inventory WHERE product = ? AND type = ? AND manufacturing = ? AND count_date = ?')
            .bind(row.product, row.type, row.manufacturing, row.count_date)
        ]);
        waitUntil(relayToLegacy(env, { action: 'deleteCount', product: row.product, type: row.type, manufacturing: row.manufacturing, date: row.count_date }));
      } else {
        // an earlier store load that day moved stock off the base; restore that level
        await env.DB.batch([
          delLog,
          env.DB.prepare(UPSERT_INVENTORY).bind(row.product, row.type, row.manufacturing, row.count_date, row.stock_before, new Date().toISOString())
        ]);
        waitUntil(relayToLegacy(env, { action: 'addCount', product: row.product, type: row.type, manufacturing: row.manufacturing, date: row.count_date, count: String(row.stock_before) }));
      }
      return json(Object.assign({ ok: true, message: 'Count deleted' }, await buildSnapshot(env)));
    }

    if (b.action === 'addStoreLoad') {
      const name = clean(b.product);
      const qty = Number(b.qty);
      if (!name || !b.type || !b.manufacturing || !isDate(b.date) || b.qty === '' || b.qty == null) throw new Error('Product, type, batch, date and count are required');
      if (!Number.isInteger(qty) || qty < 1) throw new Error('Count must be a whole number, 1 or more');
      if (isTooFarInFuture(b.date)) throw new Error('Load date cannot be in the future');
      const info = await batchInfo(env, name, b.type, b.manufacturing);
      if (!info) throw new Error('Add ' + name + ' (' + b.type + ') under Products first');
      if (info.status !== 'active') throw new Error('This batch is ' + info.status + ' and can no longer be loaded');
      if (qty > info.stock) throw new Error('Not enough stock: only ' + info.stock + ' units available');

      const after = info.stock - qty;
      const now = new Date().toISOString();
      await env.DB.batch([
        env.DB.prepare('INSERT INTO store_loads (load_date, product, type, manufacturing, qty, stock_before, stock_after, logged_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(b.date, name, b.type, b.manufacturing, qty, info.stock, after, now),
        env.DB.prepare(UPSERT_INVENTORY).bind(name, b.type, b.manufacturing, b.date, after, now)
      ]);
      waitUntil(relayToLegacy(env, { action: 'addCount', product: name, type: b.type, manufacturing: b.manufacturing, date: b.date, count: String(after) }));
      return json(Object.assign({ ok: true, message: 'Loaded ' + qty + ' - ' + after + ' units left' }, await buildSnapshot(env)));
    }

    if (b.action === 'deleteStoreLoad') {
      const id = Number(b.id);
      if (!Number.isInteger(id)) throw new Error('Store load entry is required');
      const row = await env.DB.prepare('SELECT * FROM store_loads WHERE id = ?').bind(id).first();
      if (!row) throw new Error('Store load entry not found');

      const laterCount = await env.DB.prepare(
        'SELECT 1 FROM count_log WHERE product = ? AND type = ? AND manufacturing = ? AND count_date = ? AND in_session = 1 AND logged_at > ?'
      ).bind(row.product, row.type, row.manufacturing, row.load_date, row.logged_at).first();
      if (laterCount) throw new Error('A daily count was recorded after this load - delete that count first');

      const info = await batchInfo(env, row.product, row.type, row.manufacturing);
      if (!info || info.latestDate !== row.load_date) throw new Error('Later stock entries exist for this batch - this load can no longer be undone');

      const restored = info.stock + row.qty;
      await env.DB.batch([
        env.DB.prepare('DELETE FROM store_loads WHERE id = ?').bind(id),
        env.DB.prepare(UPSERT_INVENTORY).bind(row.product, row.type, row.manufacturing, row.load_date, restored, new Date().toISOString())
      ]);
      waitUntil(relayToLegacy(env, { action: 'addCount', product: row.product, type: row.type, manufacturing: row.manufacturing, date: row.load_date, count: String(restored) }));
      return json(Object.assign({ ok: true, message: 'Store load undone' }, await buildSnapshot(env)));
    }

    throw new Error('Unknown action');
  } catch (err) {
    return json({ ok: false, error: String(err.message || err) });
  }
}
