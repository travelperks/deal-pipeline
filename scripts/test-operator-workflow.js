import assert from 'node:assert/strict';
import { buildReviewQueue, dateChange } from '../src/logic/review.js';
import { categorizeDedupeResults, exportUnmatched } from '../src/logic/dedupe.js';
import { validateDeal } from '../src/logic/copywriting.js';

const rows = [
  { hq: { id: 1, vendor: 'Carnival', text: 'Save 20%', end: new Date(2026, 9, 10) }, web: { expiryDate: new Date(2026, 9, 1) }, meta: { identical: false, differences: ['expiry'] } },
  { hq: { id: 2, vendor: 'Carnival', text: 'Free drinks' }, web: {}, meta: { identical: true, differences: [] } },
  { hq: { id: 3, vendor: 'Carnival', text: 'New offer' }, web: null, meta: { identical: false, differences: [] } },
];
const categories = categorizeDedupeResults(rows);
let queue = buildReviewQueue(categories);
assert.deepEqual(queue.pending.map(r => r.hq.id), [2], 'Identical rows are pre-checked and wait for confirmation');
assert.deepEqual(queue.work.map(r => r.hq.id), [1, 3], 'Extensions and new deals go straight to the work list');
queue = buildReviewQueue(categories, { 2: 'skip' });
assert.equal(queue.pending.length, 0);
const payload = exportUnmatched(queue.work.map(r => r.hq));
assert.ok(payload.includes('Save 20%'));
assert.ok(payload.includes('New offer'));
assert.ok(!payload.includes('Free drinks'), 'Confirmed identical deals must never enter the copy payload');
assert.equal(queue.work.length + queue.skipped.length + queue.pending.length, rows.length);
assert.deepEqual(buildReviewQueue(categories, { 2: 'work' }).work.map(r => r.hq.id), [1, 2, 3], 'A pre-checked row can be pulled into the work list');
assert.deepEqual(buildReviewQueue(categories, { 1: 'skip' }).skipped.map(r => r.hq.id), [1], 'A work row can be set aside as already on site');
assert.equal(buildReviewQueue(categories, {}).pending[0].hq.id, 2, 'Undo restores the pre-check');
assert.ok(dateChange(rows[0]));
assert.equal(dateChange({ ...rows[0], web: { expiryDate: rows[0].hq.end } }), '');

const source = { originalText: 'Save 20% on your cruise', isExclusive: false };
const clean = { headline: 'Save 20% on your cruise', description: 'Enjoy your next cruise for less.' };
assert.equal(validateDeal(clean, source).length, 0, 'Ordinary clean copy stays quiet');
assert.ok(validateDeal({ ...clean, headline: ' ' }, source).some(w => w.ruleId === 'COPY.REQUIRED_FIELD'));
assert.ok(validateDeal({ ...clean, endDate: '2/30/27' }, source).some(w => w.ruleId === 'COPY.INVALID_DATE'));
assert.ok(validateDeal({ ...clean, startDate: '10/10/26', endDate: '10/1/26' }, source).some(w => w.ruleId === 'COPY.DATE_ORDER'));
assert.ok(!validateDeal({ ...clean, endDate: '2/29/28' }, source).some(w => w.ruleId === 'COPY.INVALID_DATE'));
console.log('Operator review, copy routing, undo, and precise lint checks: PASS');
