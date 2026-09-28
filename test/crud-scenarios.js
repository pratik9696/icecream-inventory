/**
 * Regression test suite covering realistic ice-cream shop insert/update/
 * delete scenarios against functions/api/[[path]].js.
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
  await api({ action: 'deleteProduct', product: 'Mango', type: 'Mini Pack' });

  // ---- addProduct happy path + upsert ----
  r = await api({ action: 'addProduct', product: 'Mango', type: 'Family Pack', manufacturing: today(-5), count: '12' });
  check('add new product succeeds', r.ok, r.error);
  check('new product appears with correct count', r.products?.find(p => p.product === 'Mango' && p.type === 'Family Pack')?.count === 12);

  r = await api({ action: 'addProduct', product: 'Mango', type: 'Family Pack', manufacturing: today(-2), count: '20' });
  check('re-add same product+type updates, no duplicate row', r.products?.filter(p => p.product === 'Mango' && p.type === 'Family Pack').length === 1);
  check('re-add updates manufacturing date', r.products?.find(p => p.product === 'Mango' && p.type === 'Family Pack')?.manufacturing === today(-2));
  check('re-add updates count', r.products?.find(p => p.product === 'Mango' && p.type === 'Family Pack')?.count === 20);

  r = await api({ action: 'addProduct', product: 'Mango', type: 'Family Pack', manufacturing: today(-1), count: '' });
  check('re-add with blank count preserves existing count, does not reset to 1', r.products?.find(p => p.product === 'Mango' && p.type === 'Family Pack')?.count === 20);

  await api({ action: 'deleteProduct', product: 'Mango', type: 'Family Pack' });
  r = await api({ action: 'addProduct', product: 'Sitafal', type: 'Mini Pack', manufacturing: today(), count: '' });
  check('blank count on a genuinely new product still defaults to 1', r.products?.find(p => p.product === 'Sitafal')?.count === 1);
  await api({ action: 'deleteProduct', product: 'Sitafal', type: 'Mini Pack' });

  r = await api({ action: 'addProduct', product: 'Mango', type: 'Family Pack', manufacturing: today(-5), count: '12' });
  check('re-seed Mango/Family Pack', r.ok);

  r = await api({ action: 'addProduct', product: 'Mango', type: 'Mini Pack', manufacturing: today(-5), count: '18' });
  check('same flavour, different type coexists as separate row', r.products?.some(p => p.product === 'Mango' && p.type === 'Mini Pack'));
  check('both Mango rows present simultaneously', r.products?.filter(p => p.product === 'Mango').length === 2);

  // ---- addCount validation ----
  r = await api({ action: 'addCount', product: 'Vanilla', type: 'Mini Pack', date: today(), count: '5' });
  check('reject count for product not in Products', !r.ok && /under Products first/.test(r.error));

  r = await api({ action: 'addCount', product: 'Mango', type: 'Family Pack', date: today(), count: '-3' });
  check('reject negative count on addCount', !r.ok);

  r = await api({ action: 'addCount', product: 'Mango', type: 'Family Pack', date: today(), count: '0' });
  check('accept count=0 on addCount (sold out is valid)', r.ok, r.error);
  await api({ action: 'deleteCount', product: 'Mango', type: 'Family Pack', date: today() });

  r = await api({ action: 'addCount', product: 'Mango', type: 'Family Pack', date: today(), count: '7.5' });
  check('reject fractional count on addCount', !r.ok);

  r = await api({ action: 'addCount', product: 'Mango', type: 'Family Pack', date: today(2), count: '99' });
  check('reject count date more than 1 day in the future', !r.ok);

  // ---- addCount happy path + same-day overwrite + live-stock correctness ----
  r = await api({ action: 'addCount', product: 'Mango', type: 'Family Pack', date: today(-3), count: '25' });
  check('add count succeeds', r.ok, r.error);

  r = await api({ action: 'addCount', product: 'Mango', type: 'Family Pack', date: today(-3), count: '30' });
  check('same-day recount overwrites, no duplicate row', r.recent?.filter(x => x.product === 'Mango' && x.date === today(-3)).length === 1);
  check('same-day recount value updated', r.recent?.find(x => x.product === 'Mango' && x.date === today(-3))?.count === 30);

  r = await api({ action: 'addCount', product: 'Mango', type: 'Family Pack', date: today(-1), count: '40' });
  check('newer dated count becomes the live stock', r.products?.find(p => p.product === 'Mango' && p.type === 'Family Pack')?.stock === 40);

  check('product with no counts logged falls back to inward count', r.products?.find(p => p.product === 'Mango' && p.type === 'Mini Pack')?.stock === 18);

  // ---- deleteCount ----
  r = await api({ action: 'deleteCount', product: 'Mango', type: 'Family Pack', date: today(-1) });
  check('delete most-recent count succeeds', r.ok, r.error);
  check('stock falls back to next-latest remaining count after deleting the newest', r.products?.find(p => p.product === 'Mango' && p.type === 'Family Pack')?.stock === 30);

  r = await api({ action: 'deleteCount', product: 'Mango', type: 'Family Pack', date: today(-1) });
  check('double-delete of same count returns not-found, not a crash', !r.ok && /not found/i.test(r.error));

  // ---- deleteProduct ----
  r = await api({ action: 'deleteProduct', product: 'Ghost', type: 'Mini Pack' });
  check('delete nonexistent product returns not-found, not a crash', !r.ok && /not found/i.test(r.error));

  r = await api({ action: 'deleteProduct', product: 'Mango', type: 'Mini Pack' });
  check('delete product with no inventory history succeeds', r.ok, r.error);

  r = await api({ action: 'deleteProduct', product: 'Mango', type: 'Family Pack' });
  check('delete product WITH remaining inventory history succeeds (orphans the history, by design)', r.ok, r.error);

  r = await api({ action: 'addCount', product: 'Mango', type: 'Family Pack', date: today(), count: '5' });
  check('adding a count for a just-deleted product is correctly rejected', !r.ok);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    failures.forEach(f => console.log(' -', f.name, f.detail ? '(' + f.detail + ')' : ''));
    process.exit(1);
  }
}

run().catch(e => { console.error('SUITE CRASHED:', e); process.exit(1); });
