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

async function buildSnapshot(env) {
  const { results: productRows } = await env.DB.prepare(
    'SELECT product, type, manufacturing, count, status FROM products ORDER BY product, type, manufacturing'
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

  const { results: recent } = await env.DB.prepare(
    'SELECT count_date as date, product, type, manufacturing, count FROM inventory ORDER BY count_date DESC, logged_at DESC LIMIT 15'
  ).all();

  return { types: TYPES, flavours: FLAVOURS, products, recent };
}

// best-effort mirror into the existing Apps Script + Google Sheet; never blocks
// or fails the user-facing response. Uses its own LEGACY_PASSCODE (matching
// Code.gs's PASSCODE) rather than the browser's key, so the relay keeps
// authenticating even if the app-facing passcode is disabled or different.
async function relayToLegacy(env, rawBody) {
  if (!env.LEGACY_SCRIPT_URL) return;
  try {
    const body = JSON.parse(rawBody);
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

    if (b.action === 'addCount') {
      const name = clean(b.product);
      const count = Number(b.count);
      if (!name || !b.type || !b.manufacturing || !b.date || b.count === '' || !(count >= 0)) throw new Error('Product, type, batch, date and count are required');
      if (!Number.isInteger(count)) throw new Error('Count must be a whole number');
      if (isTooFarInFuture(b.date)) throw new Error('Count date cannot be in the future');
      const prod = await env.DB.prepare('SELECT 1 FROM products WHERE product = ? AND type = ? AND manufacturing = ?')
        .bind(name, b.type, b.manufacturing).first();
      if (!prod) throw new Error('Add ' + name + ' (' + b.type + ') under Products first');

      await env.DB.prepare(`
        INSERT INTO inventory (product, type, manufacturing, count_date, count, logged_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(product, type, manufacturing, count_date) DO UPDATE SET count = excluded.count, logged_at = excluded.logged_at
      `).bind(name, b.type, b.manufacturing, b.date, count, new Date().toISOString()).run();
      waitUntil(relayToLegacy(env, rawBody));
      return json(Object.assign({ ok: true, message: 'Count saved' }, await buildSnapshot(env)));
    }

    if (b.action === 'deleteCount') {
      const name = clean(b.product);
      if (!name || !b.type || !b.manufacturing || !b.date) throw new Error('Product, type, batch and date are required');
      const res = await env.DB.prepare('DELETE FROM inventory WHERE product = ? AND type = ? AND manufacturing = ? AND count_date = ?')
        .bind(name, b.type, b.manufacturing, b.date).run();
      if (!res.meta.changes) throw new Error('Count entry not found');
      waitUntil(relayToLegacy(env, rawBody));
      return json(Object.assign({ ok: true, message: 'Count deleted' }, await buildSnapshot(env)));
    }

    throw new Error('Unknown action');
  } catch (err) {
    return json({ ok: false, error: String(err.message || err) });
  }
}
