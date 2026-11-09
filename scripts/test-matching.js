import assert from 'node:assert/strict';
import { assignCandidateMatrix, ingestWebsiteJSON, parseHQ, resetIds, runFullMatch } from '../src/logic/dedupe.js';

const assign = values => assignCandidateMatrix(values.map(row => row.map(score => ({ score }))), values.length, values[0].length);
assert.deepEqual(assign([[10, 9], [0, -100]]), [[0, 0], [1, -1]], 'A bad deal must not displace a better match');
assert.deepEqual(assign([[-2, -4]]), [[0, -1]], 'All negative candidates remain unmatched');
assert.deepEqual(assign([[0]]), [[0, -1]], 'No evidence does not imply a match');
assert.deepEqual(assign([[10, 9], [9, 1]]), [[0, 1], [1, 0]], 'Keep globally optimal positive assignments');
assert.deepEqual(assign([[10], [1]]), [[0, 0], [1, -1]], 'One website deal cannot be assigned twice');

function match(source, rows, expiryDate = null, tag = 'd') {
  resetIds();
  const web = rows.map(row => typeof row === 'string' ? { shopOverline: 'Norwegian Cruise Line', title: row, expiryDate } : { shopOverline: 'Norwegian Cruise Line', expiryDate, ...row });
  return runFullMatch(parseHQ(`v\tNorwegian Cruise Line\n${tag}\t${source}`), ingestWebsiteJSON(web))[0];
}
const status = (result, key) => result.meta.checks.find(check => check.key === key)?.status;

// Every marker agrees: pre-checked as identical.
const same = match('Free Gratuities for 2 + $100 OBC ends 06/15/26', ['Free Gratuities for 2 + $100 OBC'], '2026-06-15T07:00:00Z');
assert.equal(same.meta.identical, true);
assert.equal(status(same, 'type'), 'same');
assert.equal(status(same, 'dollars'), 'same');
assert.equal(status(same, 'expiry'), 'same');

// Extension: same offer, pushed expiry. Never identical, still shown beside its sibling.
const extended = match('Free Gratuities for 2 + $100 OBC ends 07/15/26', ['Free Gratuities for 2 + $100 OBC'], '2026-06-15T07:00:00Z');
assert.equal(extended.meta.identical, false);
assert.equal(extended.web.raw.title, 'Free Gratuities for 2 + $100 OBC');
assert.deepEqual(extended.meta.differences, ['expiry']);

// Changed terms: same kind, different amount.
const changed = match('Get $150 onboard credit ends 06/15/26', ['Get $100 onboard credit'], '2026-06-15T07:00:00Z');
assert.equal(changed.meta.identical, false);
assert.deepEqual(changed.meta.differences, ['dollars']);

// Plural abbreviations and exclusivity are recognized; the kind decides the sibling.
const ppg = match('[exclusive] TLN PPGs for 2. ends 9/30.', [
  'Enjoy Summer Savings of Up to $2,500 Per Stateroom',
  'EXCLUSIVE: Enjoy Free Gratuities for 2 on Your Cruise Vacation',
  'EXCLUSIVE: Receive up to $300 in Onboard Credit for Your Cruise',
], '2026-09-30T07:00:00Z', 'ed');
assert.equal(ppg.web.raw.title, 'EXCLUSIVE: Enjoy Free Gratuities for 2 on Your Cruise Vacation');
assert.equal(ppg.meta.identical, true);

// Exclusivity mismatch is a difference, not a different kind of deal.
const notExclusive = match('TLN $100 OBC ends 06/15/26', ['Get $100 onboard credit'], '2026-06-15T07:00:00Z', 'ed');
assert.equal(notExclusive.meta.identical, false);
assert.deepEqual(notExclusive.meta.differences, ['exclusive']);

// A different kind of offer is never a sibling, even with matching numbers and dates.
const differentKind = match('Get $100 onboard credit ends 06/15/26', ['Save $100 on airfare'], '2026-06-15T07:00:00Z');
assert.equal(differentKind.web, null);
assert.equal(differentKind.meta.candidateRankings[0].score, 0);

// Repeated mentions of one amount are one term; percents compare like dollars.
const repeated = match('Get $100 onboard credit ends 06/15/26', ['Get $100 onboard credit. Enjoy your $100 onboard credit.'], '2026-06-15T07:00:00Z');
assert.equal(status(repeated, 'dollars'), 'same');
const percent = match('Save 20% and get 10% onboard credit', ['Save 20% and get 10% onboard credit', 'Save 20% and get 5% onboard credit']);
assert.equal(percent.web.raw.title, 'Save 20% and get 10% onboard credit');

// Nights are a marker too.
const nights = match('7-night Alaska from $999 ends 06/15/26', ['10-night Alaska from $999'], '2026-06-15T07:00:00Z');
assert.deepEqual(nights.meta.differences, ['nights']);

console.log('Assignment, marker checklist, identical/extension/changed outcomes: PASS');
