/**
 * Regression test suite covering realistic ice-cream shop insert/update/
 * delete scenarios against functions/api/[[path]].js.
 *
 * A "batch" is (product, type, manufacturing date) - the same flavour+type
 * can have multiple batches in flight, each with its own count and expiry.
 *
 * Run against a LOCAL dev backend only - never point BASE at production,
 * this suite creates and deletes real rows.
 *
 *   npx wrangler d1 execute icecream-db --local --file=schema.sql
 *   npx wrangler pages dev --port 8788
 *   node test/crud-scenarios.js
 */
const BASE = process.env.TEST_BASE_URL || 'http://localhost:8788/api';
const AUTH = 'Basic ' + Buffer.from('user:iceano123').toString('base64');

let pass = 0, fail = 0;
const failures = [];

function today(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

async function api(payload) {
  const opts = payload
    ? { method: 'POST', body: JSON.stringify(payload), headers: { Authorization: AUTH } }
    : { headers: { Authorization: AUTH } };
  const url = payload ? BASE : BASE + '?key=';
  const res = await fetch(url, opts);
  return res.json();
}

function check(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; failures.push({ name, detail }); console.log('FAIL:', name, detail || ''); }
}

function findBatch(products, product, type, manufacturing) {
  return products?.find(p => p.product === product && p.type === type && p.manufacturing === manufacturing);
}

async function run() {
  // ---- addProduct validation ----
  let r;

  r = await api({ action: 'addProduct', product: '', type: 'Mini Pack', manufacturing: today(), count: '' });
  check('reject empty product name', !r.ok);

  r = await api({ action: 'addProduct', product: 'Mango', type: 'Party Tub', manufacturing: today(), count: '' });
  check('reject unknown type', !r.ok && /Unknown type/.test(r.error));

  r = await api({ action: 'addProduct', product: 'Rainbow Sherbet', type: 'Mini Pack', manufacturing: today(), count: '' });
  check('reject unknown flavour', !r.ok && /Unknown flavour/.test(r.error));

  r = await api({ action: 'addProduct', product: 'Mango', type: 'Mini Pack', manufacturing: '', count: '' });
  check('reject missing manufacturing date', !r.ok);

  r = await api({ action: 'addProduct', product: 'Mango', type: 'Mini Pack', manufacturing: today(), count: '0' });
  check('reject count=0 on addProduct', !r.ok);

  r = await api({ action: 'addProduct', product: 'Mango', type: 'Mini Pack', manufacturing: today(), count: '-5' });
  check('reject negative count', !r.ok);

  r = await api({ action: 'addProduct', product: 'Mango', type: 'Mini Pack', manufacturing: today(), count: '3.5' });
  check('reject fractional count', !r.ok);

  r = await api({ action: 'addProduct', product: 'Mango', type: 'Mini Pack', manufacturing: today(2), count: '10' });
  check('reject manufacturing date more than 1 day in the future', !r.ok);

  r = await api({ action: 'addProduct', product: 'Mango', type: 'Mini Pack', manufacturing: today(1), count: '10' });
  check('accept manufacturing date 1 day ahead (timezone grace window)', r.ok, r.error);
  await api({ action: 'deleteProduct', product: 'Mango', type: 'Mini Pack', manufacturing: today(1) });

  // ---- addProduct happy path + same-batch upsert ----
  r = await api({ action: 'addProduct', product: 'Mango', type: 'Family Pack', manufacturing: today(-5), count: '12' });
  check('add new batch succeeds', r.ok, r.error);
  check('new batch appears with correct count', findBatch(r.products, 'Mango', 'Family Pack', today(-5))?.count === 12);

  r = await api({ action: 'addProduct', product: 'Mango', type: 'Family Pack', manufacturing: today(-5), count: '20' });
  check('re-add SAME batch (same triple) updates in place, no duplicate row', r.products?.filter(p => p.product === 'Mango' && p.type === 'Family Pack').length === 1);
  check('re-add same batch updates count', findBatch(r.products, 'Mango', 'Family Pack', today(-5))?.count === 20);

  r = await api({ action: 'addProduct', product: 'Mango', type: 'Family Pack', manufacturing: today(-5), count: '' });
  check('re-add same batch with blank count preserves existing count, does not reset to 1', findBatch(r.products, 'Mango', 'Family Pack', today(-5))?.count === 20);

  r = await api({ action: 'addProduct', product: 'Sitafal', type: 'Mini Pack', manufacturing: today(), count: '' });
  check('blank count on a genuinely new batch still defaults to 1', findBatch(r.products, 'Sitafal', 'Mini Pack', today())?.count === 1);
  await api({ action: 'deleteProduct', product: 'Sitafal', type: 'Mini Pack', manufacturing: today() });

  // ---- THE core feature: multiple batches of the same flavour+type ----
  r = await api({ action: 'addProduct', product: 'Mango', type: 'Family Pack', manufacturing: today(-1), count: '30' });
  check('a NEW manufacturing date for the same flavour+type creates a SECOND batch, not an overwrite',
    r.products?.filter(p => p.product === 'Mango' && p.type === 'Family Pack').length === 2);
  check('both batches keep their own distinct manufacturing date and count',
    findBatch(r.products, 'Mango', 'Family Pack', today(-5))?.count === 20 &&
    findBatch(r.products, 'Mango', 'Family Pack', today(-1))?.count === 30);

  r = await api({ action: 'addProduct', product: 'Mango', type: 'Mini Pack', manufacturing: today(-5), count: '18' });
  check('same flavour, different type is also its own row', r.products?.some(p => p.product === 'Mango' && p.type === 'Mini Pack'));

  // ---- addCount validation (batch-scoped) ----
  const D = today(-3);
  const OLD = today(-5), NEW = today(-1);
  const countOf = (snap, product, type, mfg, date) => snap.counts?.find(x => x.product === product && x.type === type && x.manufacturing === mfg && x.date === date);

  r = await api({ action: 'addCount', product: 'Vanilla', type: 'Mini Pack', manufacturing: today(), date: today(), count: '5' });
  check('reject count for a batch not in Products', !r.ok && /under Products first/.test(r.error));

  r = await api({ action: 'addCount', product: 'Mango', type: 'Family Pack', manufacturing: today(-99), date: today(), count: '5' });
  check('reject count against right flavour+type but WRONG/nonexistent manufacturing date', !r.ok && /under Products first/.test(r.error));

  r = await api({ action: 'addCount', product: 'Mango', type: 'Family Pack', manufacturing: OLD, date: today(), count: '-3' });
  check('reject negative count on addCount', !r.ok);

  r = await api({ action: 'addCount', product: 'Mango', type: 'Family Pack', manufacturing: OLD, date: today(), count: '7.5' });
  check('reject fractional count on addCount', !r.ok);

  r = await api({ action: 'addCount', product: 'Mango', type: 'Family Pack', manufacturing: OLD, date: today(2), count: '9' });
  check('reject count date more than 1 day in the future', !r.ok);

  // ---- daily count sessions ----
  r = await api({ action: 'addCount', product: 'Mango', type: 'Family Pack', manufacturing: OLD, date: D, count: '10' });
  check('reject a daily count while the session is not open', !r.ok && /not open/.test(r.error), r.error);

  r = await api({ action: 'closeCount', date: D });
  check('cannot close a session that was never opened', !r.ok);

  r = await api({ action: 'openCount', date: D });
  check('open daily count', r.ok && r.sessions?.some(x => x.date === D && !x.closed_at), r.error);

  r = await api({ action: 'openCount', date: D });
  check('opening an already-open session is rejected', !r.ok && /already open/.test(r.error));

  r = await api({ action: 'openCount', date: 'nonsense' });
  check('reject openCount with a bad date', !r.ok);

  // ceiling: a count can never exceed current inventory
  r = await api({ action: 'addCount', product: 'Mango', type: 'Family Pack', manufacturing: OLD, date: D, count: '21' });
  check('reject a count higher than current inventory (stock 20)', !r.ok && /Incorrect count/.test(r.error) && /Inward needs to be updated/.test(r.error), r.error);

  r = await api({ action: 'addCount', product: 'Mango', type: 'Family Pack', manufacturing: OLD, date: D, count: '0' });
  check('accept count=0 (sold out is valid)', r.ok, r.error);
  check('count=0 is logged with stock_before', countOf(r, 'Mango', 'Family Pack', OLD, D)?.stock_before === 20);
  let entry = countOf(r, 'Mango', 'Family Pack', OLD, D);
  r = await api({ action: 'deleteCount', id: entry.id });
  check('delete that count restores stock to the inward count', r.ok && findBatch(r.products, 'Mango', 'Family Pack', OLD)?.stock === 20, r.error);

  r = await api({ action: 'addCount', product: 'Mango', type: 'Family Pack', manufacturing: OLD, date: D, count: '20' });
  check('a count exactly equal to current inventory is accepted', r.ok, r.error);
  entry = countOf(r, 'Mango', 'Family Pack', OLD, D);
  await api({ action: 'deleteCount', id: entry.id });

  // ---- the core guarantee: a count against one batch doesn't touch the other ----
  r = await api({ action: 'addCount', product: 'Mango', type: 'Family Pack', manufacturing: OLD, date: D, count: '15' });
  check('log a count against the OLD batch', r.ok, r.error);
  check('old batch stock reflects its own count', findBatch(r.products, 'Mango', 'Family Pack', OLD)?.stock === 15);
  check('NEW batch stock is untouched by a count against the old batch', findBatch(r.products, 'Mango', 'Family Pack', NEW)?.stock === 30);
  const oldEntry = countOf(r, 'Mango', 'Family Pack', OLD, D);

  r = await api({ action: 'addCount', product: 'Mango', type: 'Family Pack', manufacturing: NEW, date: D, count: '28' });
  check('log a count against the NEW batch in the same session', r.ok, r.error);
  check('new batch stock updates independently', findBatch(r.products, 'Mango', 'Family Pack', NEW)?.stock === 28);
  check('old batch stock still unaffected by the new batch\'s count', findBatch(r.products, 'Mango', 'Family Pack', OLD)?.stock === 15);

  r = await api({ action: 'addCount', product: 'Mango', type: 'Family Pack', manufacturing: OLD, date: D, count: '10' });
  check('a batch already counted in the session cannot be counted again', !r.ok && /already counted/.test(r.error), r.error);
  const snap = await api();
  check('product with no counts logged falls back to its own inward count', snap.products.find(p => p.product === 'Mango' && p.type === 'Mini Pack')?.stock === 18);

  // ---- close / reopen ----
  r = await api({ action: 'closeCount', date: D });
  check('close daily count', r.ok && r.sessions?.find(x => x.date === D)?.closed_at, r.error);
  r = await api({ action: 'addCount', product: 'Mango', type: 'Mini Pack', manufacturing: OLD, date: D, count: '5' });
  check('no counts once the session is closed', !r.ok && /not open/.test(r.error));
  r = await api({ action: 'openCount', date: D });
  check('a closed session can be re-opened', r.ok, r.error);

  // ---- deleteCount (by log entry id) ----
  r = await api({ action: 'deleteCount', id: oldEntry.id });
  check('delete a count for one batch succeeds', r.ok, r.error);
  check('old batch stock falls back to its own inward count after its only count is deleted', findBatch(r.products, 'Mango', 'Family Pack', OLD)?.stock === 20);
  check('other batch is unaffected by deleting a different batch\'s count', findBatch(r.products, 'Mango', 'Family Pack', NEW)?.stock === 28);

  r = await api({ action: 'deleteCount', id: oldEntry.id });
  check('double-delete of same count returns not-found, not a crash', !r.ok && /not found/i.test(r.error));

  r = await api({ action: 'addCount', product: 'Mango', type: 'Family Pack', manufacturing: OLD, date: D, count: '12' });
  check('after deleting its entry the batch can be recounted', r.ok, r.error);
  await api({ action: 'deleteCount', id: countOf(r, 'Mango', 'Family Pack', OLD, D).id });
  await api({ action: 'deleteCount', id: countOf(r, 'Mango', 'Family Pack', NEW, D).id });

  // ---- store loads: own log, several per day, stock deducted ----
  const T = today();
  r = await api({ action: 'addStoreLoad', product: 'Mango', type: 'Family Pack', manufacturing: OLD, date: T, qty: '5' });
  check('store load deducts from current stock', r.ok && findBatch(r.products, 'Mango', 'Family Pack', OLD)?.stock === 15, r.error);
  const load1 = r.storeLoads?.find(x => x.product === 'Mango' && x.manufacturing === OLD && x.date === T);
  check('store load is logged with before/after', load1?.stock_before === 20 && load1?.stock_after === 15 && load1?.qty === 5);

  r = await api({ action: 'addStoreLoad', product: 'Mango', type: 'Family Pack', manufacturing: OLD, date: T, qty: '3' });
  check('a second store load the same day stacks', r.ok && findBatch(r.products, 'Mango', 'Family Pack', OLD)?.stock === 12, r.error);
  check('both same-day store loads stay visible in the log', r.storeLoads?.filter(x => x.product === 'Mango' && x.manufacturing === OLD && x.date === T).length === 2);
  const load2 = r.storeLoads?.find(x => x.stock_after === 12 && x.manufacturing === OLD);

  r = await api({ action: 'addStoreLoad', product: 'Mango', type: 'Family Pack', manufacturing: OLD, date: T, qty: '50' });
  check('store load larger than stock is rejected', !r.ok && /Not enough stock/.test(r.error), r.error);
  r = await api({ action: 'addStoreLoad', product: 'Mango', type: 'Family Pack', manufacturing: OLD, date: T, qty: '0' });
  check('store load of 0 is rejected', !r.ok);
  r = await api({ action: 'addStoreLoad', product: 'Mango', type: 'Family Pack', manufacturing: OLD, date: T, qty: '2.5' });
  check('fractional store load is rejected', !r.ok);
  r = await api({ action: 'addStoreLoad', product: 'Ghost', type: 'Family Pack', manufacturing: OLD, date: T, qty: '1' });
  check('store load for a missing batch is rejected', !r.ok && /under Products first/.test(r.error));

  // daily count after store loads is capped by the post-load stock
  await api({ action: 'openCount', date: T });
  r = await api({ action: 'addCount', product: 'Mango', type: 'Family Pack', manufacturing: OLD, date: T, count: '13' });
  check('daily count above the post-load stock (12) is rejected', !r.ok && /Incorrect count/.test(r.error), r.error);
  r = await api({ action: 'addCount', product: 'Mango', type: 'Family Pack', manufacturing: OLD, date: T, count: '11' });
  check('daily count after store loads is accepted and recorded against stock 12', r.ok && countOf(r, 'Mango', 'Family Pack', OLD, T)?.stock_before === 12, r.error);
  const afterLoadCount = countOf(r, 'Mango', 'Family Pack', OLD, T);

  r = await api({ action: 'deleteStoreLoad', id: load2.id });
  check('cannot undo a store load once a daily count was recorded after it', !r.ok && /count was recorded after/.test(r.error), r.error);

  r = await api({ action: 'deleteCount', id: afterLoadCount.id });
  check('deleting that count restores the post-load stock (12), not the inward count', r.ok && findBatch(r.products, 'Mango', 'Family Pack', OLD)?.stock === 12, r.error);

  r = await api({ action: 'deleteStoreLoad', id: load2.id });
  check('undo the second store load', r.ok && findBatch(r.products, 'Mango', 'Family Pack', OLD)?.stock === 15, r.error);
  r = await api({ action: 'deleteStoreLoad', id: load1.id });
  check('undo the first store load', r.ok && findBatch(r.products, 'Mango', 'Family Pack', OLD)?.stock === 20, r.error);
  r = await api({ action: 'deleteStoreLoad', id: load1.id });
  check('double-undo returns not-found', !r.ok && /not found/i.test(r.error));
  await api({ action: 'closeCount', date: T });

  // ---- a busy day is never truncated in the logs ----
  await api({ action: 'openCount', date: T });
  const busy = [];
  for (let i = 1; i <= 18; i++) {
    const mfg = today(-i);
    await api({ action: 'addProduct', product: 'Anjir', type: 'Mini Pack', manufacturing: mfg, count: '4' });
    busy.push(mfg);
    await api({ action: 'addCount', product: 'Anjir', type: 'Mini Pack', manufacturing: mfg, date: T, count: '4' });
    await api({ action: 'addStoreLoad', product: 'Anjir', type: 'Mini Pack', manufacturing: mfg, date: T, qty: '1' });
  }
  r = await api();
  check('all 18 of today\'s counts are returned (no 15-row cap)', r.counts?.filter(x => x.date === T && x.product === 'Anjir').length === 18, String(r.counts?.length));
  check('all 18 of today\'s store loads are returned', r.storeLoads?.filter(x => x.date === T && x.product === 'Anjir').length === 18);
  for (const c of r.counts.filter(x => x.product === 'Anjir')) await api({ action: 'deleteStoreLoad', id: r.storeLoads.find(l => l.manufacturing === c.manufacturing && l.product === 'Anjir')?.id });
  r = await api();
  for (const c of r.counts.filter(x => x.product === 'Anjir')) await api({ action: 'deleteCount', id: c.id });
  for (const mfg of busy) await api({ action: 'deleteProduct', product: 'Anjir', type: 'Mini Pack', manufacturing: mfg });
  await api({ action: 'closeCount', date: T });

  // ---- deleteProduct (batch-scoped) ----
  r = await api({ action: 'deleteProduct', product: 'Ghost', type: 'Mini Pack', manufacturing: today() });
  check('delete nonexistent batch returns not-found, not a crash', !r.ok && /not found/i.test(r.error));

  r = await api({ action: 'deleteProduct', product: 'Mango', type: 'Family Pack', manufacturing: OLD });
  check('delete one batch succeeds', r.ok, r.error);
  check('deleting one batch leaves the OTHER batch of the same flavour+type intact', findBatch(r.products, 'Mango', 'Family Pack', NEW)?.stock === 30);

  r = await api({ action: 'addCount', product: 'Mango', type: 'Family Pack', manufacturing: OLD, date: D, count: '5' });
  check('adding a count against a just-deleted batch is correctly rejected', !r.ok);

  // cleanup
  await api({ action: 'deleteProduct', product: 'Mango', type: 'Family Pack', manufacturing: NEW });
  await api({ action: 'deleteProduct', product: 'Mango', type: 'Mini Pack', manufacturing: OLD });
  await api({ action: 'closeCount', date: D });

  // ---- batch status (returned/disposed) ----
  r = await api({ action: 'addProduct', product: 'Sitafal', type: 'Family Pack', manufacturing: today(-40), count: '4' });
  check('new batch defaults to status active', findBatch(r.products, 'Sitafal', 'Family Pack', today(-40))?.status === 'active');

  r = await api({ action: 'setBatchStatus', product: 'Sitafal', type: 'Family Pack', manufacturing: today(-40), status: 'returned' });
  check('setBatchStatus succeeds', r.ok, r.error);
  check('status updated to returned', findBatch(r.products, 'Sitafal', 'Family Pack', today(-40))?.status === 'returned');

  r = await api({ action: 'setBatchStatus', product: 'Sitafal', type: 'Family Pack', manufacturing: today(-40), status: 'bogus' });
  check('reject unknown status value', !r.ok);

  r = await api({ action: 'setBatchStatus', product: 'Ghost', type: 'Family Pack', manufacturing: today(), status: 'disposed' });
  check('setBatchStatus on nonexistent batch returns not-found', !r.ok && /not found/i.test(r.error));

  r = await api({ action: 'addCount', product: 'Sitafal', type: 'Family Pack', manufacturing: today(-40), date: today(), count: '1' });
  check('a returned batch can no longer be counted', !r.ok && /returned/.test(r.error), r.error);
  r = await api({ action: 'addStoreLoad', product: 'Sitafal', type: 'Family Pack', manufacturing: today(-40), date: today(), qty: '1' });
  check('a returned batch can no longer be store-loaded', !r.ok && /returned/.test(r.error), r.error);

  await api({ action: 'deleteProduct', product: 'Sitafal', type: 'Family Pack', manufacturing: today(-40) });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    failures.forEach(f => console.log(' -', f.name, f.detail ? '(' + f.detail + ')' : ''));
    process.exit(1);
  }
}

run().catch(e => { console.error('SUITE CRASHED:', e); process.exit(1); });
