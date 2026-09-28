/**
 * ONE-TIME data export helper. Paste this function into the SAME Apps Script
 * project as Code.gs, temporarily (do not deploy it - just run it from the
 * Apps Script editor). It dumps the FULL Products and Inventory sheets
 * (not the bounded/15-row versions used by the live API) as JSON.
 *
 * How to run:
 *   1. Extensions > Apps Script > paste this function anywhere in Code.gs.
 *   2. Select "exportAll" in the function dropdown at the top, click Run.
 *   3. View > Logs (or Ctrl+Enter) to see the output.
 *   4. Copy the full JSON output and save it as export.json next to this file.
 *   5. Delete this function again once you're done (or just leave it - it's
 *      inert until run, and isn't part of the deployed web app).
 */
function exportAll() {
  const ss = SpreadsheetApp.getActive();
  const products = ss.getSheetByName('Products').getDataRange().getValues().slice(1)
    .filter(r => r[0] !== '')
    .map(r => ({
      product: r[0],
      type: r[1],
      manufacturing: Utilities.formatDate(r[2], Session.getScriptTimeZone(), 'yyyy-MM-dd'),
      count: r[4] === '' ? 1 : r[4],
      added_on: r[3] instanceof Date ? r[3].toISOString() : new Date().toISOString()
    }));
  const inventory = ss.getSheetByName('Inventory').getDataRange().getValues().slice(1)
    .filter(r => r[1] !== '')
    .map(r => ({
      product: r[1],
      type: r[2],
      count_date: Utilities.formatDate(r[0], Session.getScriptTimeZone(), 'yyyy-MM-dd'),
      count: r[3],
      logged_at: r[4] instanceof Date ? r[4].toISOString() : new Date().toISOString()
    }));
  Logger.log(JSON.stringify({ products: products, inventory: inventory }));
}
