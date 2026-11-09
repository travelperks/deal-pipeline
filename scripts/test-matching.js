import assert from 'node:assert/strict';
import { assignCandidateMatrix, categorizeDedupeResults, ingestWebsiteJSON, parseHQ, resetIds, runFullMatch } from '../src/logic/dedupe.js';

const assign = values => assignCandidateMatrix(values.map(row => row.map(score => ({ score }))), values.length, values[0].length);
assert.deepEqual(assign([[10, 9], [0, -100]]), [[0, 0], [1, -1]], 'A bad deal must not displace a better match');
assert.deepEqual(assign([[-2, -4]]), [[0, -1]], 'All negative candidates remain unmatched');
assert.deepEqual(assign([[0]]), [[0, -1]], 'No evidence does not imply a match');
assert.deepEqual(assign([[10, 9], [9, 1]]), [[0, 1], [1, 0]], 'Keep globally optimal positive assignments');
assert.deepEqual(assign([[10], [1]]), [[0, 0], [1, -1]], 'One website deal cannot be assigned twice');

// Dates in these cases are fixed relative to a pinned "today" so the suite
// does not start failing when the calendar moves on.
const TODAY = new Date(2026, 10, 9, 12);
const iso = (md) => { const [m, d, y = 2026] = md.split('/').map(Number); return new Date(y, m - 1, d, 16).toISOString(); };

/** Runs tagged lines for one supplier against website rows `[title, expiry, listing]`. */
function run(lines, rows) {
  resetIds();
  const web = rows.map(([title, expiry, shopListing = '']) => ({ shopOverline: 'Norwegian Cruise Line', title, shopListing, expiryDate: expiry ? iso(expiry) : null }));
  return runFullMatch(parseHQ(`v\tNorwegian Cruise Line\n${lines.join('\n')}`), ingestWebsiteJSON(web), { today: TODAY });
}
const one = (line, rows) => run([line], rows)[0];
const verdicts = (results) => results.map(r => r.meta.verdict);

// Same offer, amounts and date: already on the site.
const same = one('d\tFree Gratuities for 2 + $100 OBC ends 06/15/27', [['Free Gratuities for 2 + $100 OBC', '6/15/2027']]);
assert.equal(same.meta.verdict, 'on-site');
assert.equal(same.meta.identical, true);

// Extension: same offer, pushed end date.
const extended = one('d\tCyber Bonus up to $150 OBC: Ends 11/16/2026', [['Receive Up to $150 Onboard Credit with the Cyber Bonus', '11/9']]);
assert.equal(extended.meta.verdict, 'update');
assert.match(extended.meta.reason, /End date changed/);
assert.deepEqual(extended.meta.differences, ['expiry']);

// Changed terms on the same date.
const changed = one('d\tGet $150 onboard credit ends 06/15/27', [['Get $100 onboard credit', '6/15/2027']]);
assert.equal(changed.meta.verdict, 'update');
assert.match(changed.meta.reason, /different amounts/);

// Website copy adds detail the source line never had; the leading figures decide.
assert.equal(one('ed\tThe Exclusive Invitation to Black Friday up to 40% Savings: Ends 12/1/2026',
  [['EXCLUSIVE: Save Up to 40% with The Exclusive Invitation', '12/1', 'Save up to 40% on Advance Fares or 30% on Flexible Fares during the Black Friday Sale.']]).meta.verdict, 'on-site');
assert.equal(one('d\tBlue Friday Sale-up to 50% off, up to $400 Instant Savings, 50% Deposits & Free 3rd/4th Guests: Ends 12/7/2026',
  [['Enjoy Up to 50% off and Up to $400 Instant Savings', '12/7', 'Shop the Blue Friday sale for huge instant savings.']]).meta.verdict, 'on-site');
assert.equal(one('d\tCHA Values Q4 up to $75 Dining Credit (OBC): Ends 11/30/2026',
  [['Receive Up to $75 in Dining Onboard Credit While Sailing', '11/30']]).meta.verdict, 'on-site');

// A parenthetical aside on the source line is not part of the offer.
assert.equal(one('d\tBlack Friday Preview Sale-up to $300 OBC on 2027 Med Sailings (Stackable with up to $600 Free Drinks & 80% off 2nd Sailor): Ends 11/11/2026',
  [['Receive Up to $300 Onboard Credit on Select 2027 Med Sailings', '11/11']]).meta.verdict, 'on-site');

// A figure the website leads with must be in the source too.
assert.equal(one('d\tSave on Sunshine Sale-up to $200 OBC: Ends 12/31/2026',
  [['Save Up to 50% Plus Up to $400 in Onboard Credit', '12/31', 'Take advantage of the Save on Sunshine Sale.']]).meta.verdict, 'update');

// HQ shorthand.
assert.equal(one('d\tBOGO60: Ends 11/30/2026', [['Save 60% off the Second Guest on Your Upcoming Vacation', '11/30']]).meta.verdict, 'on-site');
assert.equal(one('ed\tEXCLUSIVE TLN PPGs for 2: Ends 11/30/2026', [
  ['Enjoy Summer Savings of Up to $2,500 Per Stateroom', '11/30'],
  ['EXCLUSIVE: Enjoy Free Gratuities for Two on Your Next Sailing Vacation', '11/30', 'Take advantage of prepaid gratuities covered for two guests.'],
  ['EXCLUSIVE: Receive up to $300 in Onboard Credit for Your Cruise', '11/30'],
]).web.raw.title, 'EXCLUSIVE: Enjoy Free Gratuities for Two on Your Next Sailing Vacation');

// One hidden-rates entry covers every covert rate code, whatever its date.
const covert = run(['d\tCovert BC50 Rates: Ongoing', 'd\tCovert BC100 Rates: Ongoing', 'ed\tEXCLUSIVE Covert CUG Sailings: Capacity Controlled', 'd\tCovert Fares: Ends 10/15/2026'],
  [['EXCLUSIVE: Hidden Fares Too Low to Show Online', '11/19']]);
assert.deepEqual(verdicts(covert), ['on-site', 'on-site', 'on-site', 'on-site']);
assert.equal(one('d\tCovert Rates: Ends 12/15/2026', [['EXCLUSIVE: Hidden Fares Too Low to Show Online', '11/19']]).meta.verdict, 'update');

// One website deal is never used twice: the closer line keeps it.
const wine = run(['ed\tEXCLUSIVE TLN Bottle of Wine: Ends 11/30/2026', 'ed\tEXCLUSIVE TLN Bottle of Wine & Box of Chocolates: Ends 11/30/2026'],
  [['EXCLUSIVE: Receive a Complimentary Bottle of Wine on Your Next Voyage', '11/30']]);
assert.deepEqual(verdicts(wine), ['on-site', 'new']);
const credits = run(['ed\tTLN up to $200 Shipboard Credit: Ends 11/30/2026', 'ed\tEXCLUSIVE up to $200 OBC: Ends 12/31/2026'],
  [['EXCLUSIVE: Get Up to $200 in Shipboard Credit on Board', '12/31']]);
assert.deepEqual(verdicts(credits), ['new', 'on-site']);

// A source line that omits "exclusive" still matches the site's exclusive
// entry; a site entry missing the exclusive mark is worth a look.
assert.equal(one('d\tUp to $1000 Shipboard Credit: Ends 12/31/2026', [['EXCLUSIVE: Receive Up to $1,000 in Onboard Credit for Your Voyage', '12/31']]).meta.verdict, 'on-site');
const notExclusive = one('ed\tTLN $100 OBC ends 06/15/27', [['Get $100 onboard credit', '6/15/2027']]);
assert.equal(notExclusive.meta.verdict, 'update');
assert.match(notExclusive.meta.reason, /not marked exclusive/);

// Unrelated deals are new, even with a shared kind, figure or date.
assert.equal(one('d\tGet $100 onboard credit ends 06/15/27', [['Save $100 on airfare', '6/15/2027']]).meta.verdict, 'new');
assert.equal(one('d\tFLATOFF up to $1000 off per Stateroom: 11/12-11/18/2026', [['Teacher Cruise Discount - Save up to 15% Off!', null]]).meta.verdict, 'new');
assert.equal(one('ed\tEXCLUSIVE CS Sale up to $150 OBC: 11/11-11/18/2026', [['Bonus Onboard Credit for Teachers', null]]).meta.verdict, 'new');
assert.equal(one('d\tBlack Friday Event-up to 40% off, 10% Reduced Dep, up to $200 OBC: 11/10-12/7/2026', [['EXCLUSIVE: Get Up to $250 in Onboard Credit', '11/18']]).meta.verdict, 'new');
assert.equal(one('d\t7-night Alaska from $999 ends 06/15/27', [['10-night Alaska from $999', '6/15/2027']]).meta.verdict !== 'on-site', true);

// Already-live deals leave the work list; updates and new deals stay on it.
const mixed = run(['d\tCyber Bonus up to $150 OBC: Ends 11/16/2026', 'd\tBOGO60: Ends 11/30/2026', 'd\tFLATOFF up to $1000 off per Stateroom: 11/12-11/18/2026'],
  [['Receive Up to $150 Onboard Credit with the Cyber Bonus', '11/9'], ['Save 60% off the Second Guest on Your Upcoming Vacation', '11/30']]);
const sorted = categorizeDedupeResults(mixed, { today: TODAY });
assert.deepEqual(sorted.identical.map(r => r.hq.text), ['BOGO60: Ends 11/30/2026']);
assert.deepEqual(verdicts(sorted.work), ['update', 'new']);

console.log('Assignment, on-site / update / new outcomes, covert and one-to-one rules: PASS');
