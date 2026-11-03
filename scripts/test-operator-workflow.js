import assert from 'node:assert/strict';
import { buildReviewQueue } from '../src/logic/review.js';
import { categorizeDedupeResults, exportUnmatched } from '../src/logic/dedupe.js';
import { buildPublishHandoff, applyDecisions } from '../src/logic/jev.js';
import { validateDeal } from '../src/logic/copywriting.js';

const today = new Date(2026, 9, 13);
const rows = [
  { hq: { id: 1, vendor: 'Carnival', text: 'Save 20%', end: new Date(2026, 9, 20) }, web: {}, meta: { verdict: 'update' } },
  { hq: { id: 2, vendor: 'Carnival', text: 'Free drinks' }, web: {}, meta: { verdict: 'on-site' } },
  { hq: { id: 3, vendor: 'Carnival', text: 'New offer' }, web: null, meta: { verdict: 'new' } },
  { hq: { id: 4, vendor: 'Carnival', text: 'Unsure offer' }, web: {}, meta: { verdict: 'update', guess: true } },
  { hq: { id: 5, vendor: 'Carnival', text: 'Last day', end: today }, web: null, meta: { verdict: 'new' } },
];
const categories = categorizeDedupeResults(rows, { today });
const ids = list => list.map(r => r.hq.id);
let queue = buildReviewQueue(categories);
assert.equal(queue.ask, undefined, 'Nothing ever waits on the operator');
assert.deepEqual(ids(queue.update), [1, 4], 'Best guesses go forward as updates');
assert.deepEqual(ids(queue.added), [3], 'Nothing-similar rows go straight through as new');
assert.deepEqual(ids(queue.onSite), [2]);
assert.deepEqual(ids(queue.excluded), [5], 'Ending today is always excluded');
queue = buildReviewQueue(categories, { 2: 'new', 1: 'on-site' });
assert.deepEqual(ids(queue.update), [4]);
assert.deepEqual(ids(queue.added), [2, 3]);
assert.deepEqual(ids(queue.onSite), [1]);
assert.deepEqual(ids(buildReviewQueue(categories, { 3: 'update' }).added), [3], 'A row with no website deal cannot become an update');
const payload = exportUnmatched([...queue.update, ...queue.added].map(r => r.hq));
assert.ok(payload.includes('New offer'));
assert.ok(!payload.includes('Save 20%'), 'On-site deals never enter the publish payload');
assert.ok(!payload.includes('Last day'), 'Ending-today deals never enter the publish payload');

const suspicious = { hq: { id: 101, vendor: 'Carnival', type: 'exclusive', text: 'EXCLUSIVE 10% savings' }, web: null, meta: { verdict: 'new', reviewReason: 'matching-terms', candidates: [], reviewCandidates: [{}] } };
const ready = { hq: { id: 102, vendor: 'Carnival', type: 'deal', text: 'Save 25%' }, web: null, meta: { verdict: 'new', candidates: [] } };
assert.equal(buildPublishHandoff(categorizeDedupeResults([ready, suspicious], { today })), null, 'A ready deal must not carry an unresolved suspect deal across Publish');
const approved = applyDecisions([ready, suspicious], { 101: { verdict: 'new' } }, []);
const handoff = buildPublishHandoff(categorizeDedupeResults(approved, { today }));
assert.ok(handoff.text.includes('EXCLUSIVE 10% savings'));
assert.equal(handoff.actions.length, 2);
const duplicatePayload = exportUnmatched([ready.hq, { ...ready.hq, id: 103 }]);
assert.equal(duplicatePayload.split('\n').filter(line => line.startsWith('d\t')).length, 1, 'Duplicate offers must not survive the Publish serialization boundary');

const source = { originalText: 'Save 20% on your cruise', isExclusive: false };
const clean = { headline: 'Save 20% on your cruise', description: 'Enjoy your next cruise for less.' };
assert.equal(validateDeal(clean, source).length, 0, 'Ordinary clean copy stays quiet');
assert.ok(validateDeal({ ...clean, headline: ' ' }, source).some(w => w.ruleId === 'COPY.REQUIRED_FIELD'));
assert.ok(validateDeal({ ...clean, endDate: '2/30/27' }, source).some(w => w.ruleId === 'COPY.INVALID_DATE'));
assert.ok(validateDeal({ ...clean, startDate: '10/10/26', endDate: '10/1/26' }, source).some(w => w.ruleId === 'COPY.DATE_ORDER'));
assert.ok(!validateDeal({ ...clean, endDate: '2/29/28' }, source).some(w => w.ruleId === 'COPY.INVALID_DATE'));
console.log('Operator verdict queue, overrides, copy routing, and precise lint checks: PASS');
