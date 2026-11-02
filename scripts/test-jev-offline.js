// Offline checks for how Jev's answers become verdicts (DEC-07). No network.
import assert from 'node:assert/strict';
import { parseHQ, resetIds, ingestWebsiteJSON, categorizeDedupeResults } from '../src/logic/dedupe.js';
import { buildJevRequest, candidatesFor, compareWithJev, reconsiderWithJev, needsReview } from '../src/logic/jev.js';

const today = new Date(2026, 9, 13);
const choice = (c, confidence = 0.9, probabilities = {}) => ({ type: 'choice', choice: c, confidence, probabilities });
const site = (vendor, rows) => ingestWebsiteJSON(rows.map(([title, expiryDate = null, shopListing = '']) => ({ shopOverline: vendor, title, shopListing, expiryDate })));
async function run(source, web, answers, tag = 'd', vendor = 'Cunard') {
  resetIds();
  const hq = parseHQ(`v\t${vendor}\n${tag}\t${source}`);
  return (await compareWithJev(hq, site(vendor, web), async () => answers, { today })).results[0];
}

// The request carries typed facts and how each candidate compares.
resetIds();
const req = buildJevRequest(parseHQ('v\tCunard\nd\tUp to $250 OBC: Ends 11/18/2026')[0], site('Cunard', [['Save 40%'], ['Receive Up to $350 Onboard Credit']]), today);
assert.deepEqual(Object.keys(req.questions), ['status', 'match']);
assert.deepEqual(Object.keys(req.questions.match.criteria), ['w1', 'w2', 'none']);
assert.equal(req.state.incoming_deal.facts.amounts, '$250');
assert.equal(req.state.website_deals.w2.compared.amounts, 'different');
assert.equal(req.state.website_deals.w2.compared.ends, 'incoming adds an end date');
assert.equal(req.state.website_deals.w1.compared.amounts, 'only incoming states');
assert.ok(req.state.rules.length >= 8, 'Jev is taught the compiled rules');

// Exclusive and public deals are never even offered to Jev as candidates.
resetIds();
const excl = parseHQ('v\tViking Ocean\ned\tEXCLUSIVE up to $200 OBC')[0];
assert.equal(candidatesFor(excl, site('Viking Ocean', [['Up to $200 Onboard Credit']])).length, 0);

// Update: Jev picks the entry; changes are spelled out from the parsed terms.
const upd = await run('Up to $250 OBC: Ends 11/18/2026', [['Save 40%'], ['Receive Up to $350 Onboard Credit', '2026-11-18T08:00:00Z']],
  { status: choice('update'), match: choice('w2', 0.9, { w1: 0.1, w2: 0.9 }) });
assert.equal(upd.meta.verdict, 'update');
assert.equal(upd.web.raw.title, 'Receive Up to $350 Onboard Credit');
assert.ok(upd.meta.changes.includes('Amount $350 → $250'));
assert.deepEqual(upd.meta.ranked.map(r => r.web.raw.title), ['Receive Up to $350 Onboard Credit', 'Save 40%'], 'Candidates ranked by Jev for "not this one"');

// Live needs Jev to say live and every stated term to agree.
const live = await run('Up to $350 OBC: Ends 11/18/2026', [['Receive Up to $350 Onboard Credit', '2026-11-18T08:00:00Z']],
  { status: choice('live'), match: choice('w1') });
assert.equal(live.meta.verdict, 'on-site');
const notLive = await run('Up to $250 OBC: Ends 11/18/2026', [['Receive Up to $350 Onboard Credit', '2026-11-18T08:00:00Z']],
  { status: choice('live'), match: choice('w1') });
assert.equal(notLive.meta.verdict, 'update', 'Different amounts are never live');

// Status says update but match says none: take the likeliest entry.
const noMatch = await run('Up to $250 OBC', [['Save 40%'], ['Receive Up to $350 Onboard Credit']],
  { status: choice('update', 0.8), match: choice('none', 0.5, { w1: 0.1, w2: 0.4, none: 0.5 }) });
assert.equal(noMatch.web.raw.title, 'Receive Up to $350 Onboard Credit');
assert.ok(noMatch.meta.confidence <= 0.4, 'A rescued match is reported as unsure');

// New: no website entry.
const fresh = await run('Kids Sail Free', [['Receive Up to $350 Onboard Credit']], { status: choice('new'), match: choice('none') });
assert.equal(fresh.web, null);
assert.equal(fresh.meta.verdict, 'new');

// Reconsider tells Jev what the operator doubts.
let sent = null;
resetIds();
const rq = parseHQ('v\tCunard\nd\tUp to $250 OBC')[0];
const again = await reconsiderWithJev(rq, site('Cunard', [['Receive Up to $350 Onboard Credit']]), site('Cunard', [['Receive Up to $350 Onboard Credit']])[0], async (body) => { sent = body; return { status: choice('new'), match: choice('none') }; }, today);
assert.match(sent.state.operator_note, /doubts that "Receive Up to \$350 Onboard Credit"/);
assert.equal(again.reconsidered, true);

// Jev failing keeps the rule-based verdict, marked so the UI can say so.
resetIds();
const hq = parseHQ('v\tCunard\nd\tUp to $250 OBC: Ends 11/18/2026');
const failed = (await compareWithJev(hq, site('Cunard', [['Receive Up to $350 Onboard Credit', '2026-11-18T08:00:00Z']]), async () => { throw new Error('down'); }, { today })).results[0];
assert.equal(failed.meta.jevError, true);
assert.equal(failed.meta.verdict, 'update');

// A temporary first-request failure must recover without an operator retry.
let attempts = 0;
const recovered = await compareWithJev(hq, site('Cunard', [['Receive Up to $350 Onboard Credit']]), async () => {
  if (++attempts === 1) throw new Error('temporary network failure');
  return { status: choice('update'), match: choice('w1') };
}, { today, retryDelayMs: 0 });
assert.equal(recovered.results[0].meta.jevError, undefined, 'Initial transient failures should retry automatically');
assert.equal(attempts, 2);

// An incomplete saved answer is retried, while a successful saved answer is reused.
let recoveredCacheCalls = 0;
const partial = await compareWithJev(hq, site('Cunard', [['Receive Up to $350 Onboard Credit']]), async () => {
  recoveredCacheCalls++;
  return { status: choice('update'), match: choice('w1') };
}, { today, cache: { [hq[0].id]: { status: choice('update') } }, retryDelayMs: 0 });
assert.equal(recoveredCacheCalls, 1);
assert.equal(partial.results[0].meta.jevError, undefined);
let cachedRequests = 0;
const cached = await compareWithJev(hq, site('Cunard', [['Receive Up to $350 Onboard Credit']]), async () => { cachedRequests++; throw new Error('Unexpected request'); }, { today, cache: partial.answers });
assert.equal(cachedRequests, 0, 'Successful cached answers must not be requested again');
assert.equal(cached.results[0].meta.jevError, undefined);
let permanentRequests = 0;
await compareWithJev(hq, site('Cunard', [['Receive Up to $350 Onboard Credit']]), async () => {
  permanentRequests++; throw Object.assign(new Error('Forbidden'), { status: 403 });
}, { today, retryDelayMs: 0 });
assert.equal(permanentRequests, 1, 'Permanent request errors must not be retried');

// A supplier with nothing on the site is never sent to Jev.
let calls = 0;
resetIds();
await compareWithJev(parseHQ('v\tCarnival\nd\tSave 20%'), site('Cunard', [['X']]), async () => { calls++; return {}; }, { today });
assert.equal(calls, 0);

// Ending today is still excluded whatever Jev says.
let askedEndingToday = 0;
resetIds();
const endsToday = (await compareWithJev(parseHQ('v\tCunard\nd\tUp to $250 OBC: Ends 10/13/2026'), site('Cunard', [['Receive Up to $350 Onboard Credit']]), async () => { askedEndingToday++; return {}; }, { today })).results[0];
assert.equal(askedEndingToday, 0, 'Deals ending today are not sent to Jev');
assert.equal(categorizeDedupeResults([endsToday], { today }).excluded.length, 1);

// Ongoing vs no end date is the same thing: open-ended, and live when all else agrees.
const open = await run('EXCLUSIVE Covert Fares: Ongoing', [['EXCLUSIVE: Secret Rates – Unveil the Luxury!']],
  { status: choice('update', 0.6, { live: 0.4, update: 0.6, new: 0 }), match: choice('w1', 0.99, { w1: 0.99, none: 0.01 }) }, 'ed', 'Seabourn');
resetIds();
const openReq = buildJevRequest(parseHQ('v\tSeabourn\ned\tEXCLUSIVE Covert Fares: Ongoing')[0], site('Seabourn', [['EXCLUSIVE: Secret Rates']]), today);
assert.equal(openReq.state.website_deals.w1.compared.ends, 'same (both open-ended)');
assert.ok(openReq.state.rules.some(r => /Ongoing.*no end date.*same thing/.test(r)));

// Sureness is about the match, not Jev's live/update split: a 99% match is not "unsure".
assert.ok(open.meta.confidence >= 0.98, `confidence ${open.meta.confidence}`);
assert.equal(needsReview(open), false, 'A 99% match never reaches the operator');
const wine = await run('EXCLUSIVE Bottle of Wine: Ends 10/31/2026', [['EXCLUSIVE: Receive a Bottle of Wine', '2026-10-31T07:00:00Z']],
  { status: choice('live', 0.37, { live: 0.55, update: 0.45, new: 0 }), match: choice('w1', 1, { w1: 1, none: 0 }) }, 'ed', 'Avalon Waterways');
assert.equal(wine.meta.verdict, 'on-site');
assert.equal(needsReview(wine), false);

// Unsure match, plausible "new", and Jev errors do reach the operator.
assert.equal(needsReview(noMatch), true);
const maybeNew = await run('Kids Sail Free', [['Kids Sail Free on Select Sailings']], { status: choice('new', 0.6, { new: 0.6, update: 0.4 }), match: choice('none', 0.5, { w1: 0.45, none: 0.55 }) });
assert.equal(needsReview(maybeNew), true, 'Jev saying new while a deal looks like a match is reviewed');
assert.equal(needsReview(fresh), true === (fresh.meta.confidence < 0.8));
assert.equal(needsReview(failed), true);

console.log('Jev answer handling (offline): PASS');
