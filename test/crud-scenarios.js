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

  // ---- addCount validation (now batch-scoped) ----
  r = await api({ action: 'addCount', product: 'Vanilla', type: 'Mini Pack', manufacturing: today(), date: today(), count: '5' });
  check('reject count for a batch not in Products', !r.ok && /under Products first/.test(r.error));

  r = await api({ action: 'addCount', product: 'Mango', type: 'Family Pack', manufacturing: today(-99), date: today(), count: '5' });
  check('reject count against right flavour+type but WRONG/nonexistent manufacturing date', !r.ok && /under Products first/.test(r.error));

  r = await api({ action: 'addCount', product: 'Mango', type: 'Family Pack', manufacturing: today(-5), date: today(), count: '-3' });
  check('reject negative count on addCount', !r.ok);

  r = await api({ action: 'addCount', product: 'Mango', type: 'Family Pack', manufacturing: today(-5), date: today(), count: '0' });
  check('accept count=0 on addCount (sold out is valid)', r.ok, r.error);
  await api({ action: 'deleteCount', product: 'Mango', type: 'Family Pack', manufacturing: today(-5), date: today() });

  r = await api({ action: 'addCount', product: 'Mango', type: 'Family Pack', manufacturing: today(-5), date: today(), count: '7.5' });
  check('reject fractional count on addCount', !r.ok);

  r = await api({ action: 'addCount', product: 'Mango', type: 'Family Pack', manufacturing: today(-5), date: today(2), count: '99' });
  check('reject count date more than 1 day in the future', !r.ok);

  // ---- the core guarantee: a count against one batch doesn't touch the other ----
  r = await api({ action: 'addCount', product: 'Mango', type: 'Family Pack', manufacturing: today(-5), date: today(-3), count: '15' });
  check('log a count against the OLD batch', r.ok, r.error);
  check('old batch stock reflects its own count', findBatch(r.products, 'Mango', 'Family Pack', today(-5))?.stock === 15);
  check('NEW batch stock is untouched by a count against the old batch', findBatch(r.products, 'Mango', 'Family Pack', today(-1))?.stock === 30);

  r = await api({ action: 'addCount', product: 'Mango', type: 'Family Pack', manufacturing: today(-1), date: today(-3), count: '28' });
  check('log a count against the NEW batch on the same date', r.ok, r.error);
  check('new batch stock updates independently', findBatch(r.products, 'Mango', 'Family Pack', today(-1))?.stock === 28);
  check('old batch stock still unaffected by the new batch\'s count', findBatch(r.products, 'Mango', 'Family Pack', today(-5))?.stock === 15);

  // ---- same-day recount overwrite (still per batch) ----
  r = await api({ action: 'addCount', product: 'Mango', type: 'Family Pack', manufacturing: today(-5), date: today(-3), count: '10' });
  check('same-day recount on a batch overwrites, no duplicate row', r.recent?.filter(x => x.product === 'Mango' && x.manufacturing === today(-5) && x.date === today(-3)).length === 1);
  check('same-day recount value updated for that batch', findBatch(r.products, 'Mango', 'Family Pack', today(-5))?.stock === 10);

  check('product with no counts logged falls back to its own inward count', r.products?.find(p => p.product === 'Mango' && p.type === 'Mini Pack')?.stock === 18);

  // ---- deleteCount (batch-scoped) ----
  r = await api({ action: 'deleteCount', product: 'Mango', type: 'Family Pack', manufacturing: today(-5), date: today(-3) });
  check('delete a count for one batch succeeds', r.ok, r.error);
  check('old batch stock falls back to its own inward count after its only count is deleted', findBatch(r.products, 'Mango', 'Family Pack', today(-5))?.stock === 20);
  check('other batch is unaffected by deleting a different batch\'s count', findBatch(r.products, 'Mango', 'Family Pack', today(-1))?.stock === 28);

  r = await api({ action: 'deleteCount', product: 'Mango', type: 'Family Pack', manufacturing: today(-5), date: today(-3) });
  check('double-delete of same count returns not-found, not a crash', !r.ok && /not found/i.test(r.error));

  // ---- deleteProduct (batch-scoped) ----
  r = await api({ action: 'deleteProduct', product: 'Ghost', type: 'Mini Pack', manufacturing: today() });
  check('delete nonexistent batch returns not-found, not a crash', !r.ok && /not found/i.test(r.error));

  r = await api({ action: 'deleteProduct', product: 'Mango', type: 'Family Pack', manufacturing: today(-5) });
  check('delete one batch succeeds', r.ok, r.error);
  check('deleting one batch leaves the OTHER batch of the same flavour+type intact', findBatch(r.products, 'Mango', 'Family Pack', today(-1))?.stock === 28);

  r = await api({ action: 'addCount', product: 'Mango', type: 'Family Pack', manufacturing: today(-5), date: today(), count: '5' });
  check('adding a count against a just-deleted batch is correctly rejected', !r.ok);

  // cleanup
  await api({ action: 'deleteProduct', product: 'Mango', type: 'Family Pack', manufacturing: today(-1) });
  await api({ action: 'deleteProduct', product: 'Mango', type: 'Mini Pack', manufacturing: today(-5) });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    failures.forEach(f => console.log(' -', f.name, f.detail ? '(' + f.detail + ')' : ''));
    process.exit(1);
  }
}

run().catch(e => { console.error('SUITE CRASHED:', e); process.exit(1); });
