import assert from 'node:assert/strict';
import { inputLines, buildTagRequest, assembleTagResult, feedbackBlock } from '../src/logic/tagJev.js';
import { supplierNames } from '../src/logic/suppliers.js';
import { onRequestPost } from '../functions/api/jev.js';

const raw = 'Carnival\r\nSave 50%\r\n  through November 30\r\nAnother supplier?\r\nUnsubscribe';
const lines = inputLines(raw);
const supplier = `s${supplierNames.indexOf('Carnival')}`;
const answer = (choice, confidence = .95) => ({ choice, probabilities: { [choice]: confidence } });
const answers = Object.fromEntries(lines.flatMap((line, i) => [
  [`tag_kind_${line.id}`, answer(['supplier', 'exclusive', 'continuation', 'deal', 'ignore'][i])],
  [`tag_supplier_${line.id}`, answer(i === 3 ? 'unknown' : supplier)],
]));
const result = assembleTagResult(lines, answers);
assert.equal(result.records[1].text, 'Save 50% through November 30');
assert.equal(result.records[1].kind, 'exclusive');
assert.deepEqual(result.records[1].sourceLines, [2, 3]);
assert.equal(result.records[2].kind, 'review', 'Unknown supplier must be reviewable');
assert.equal(result.records[3].kind, 'ignore', 'Clutter remains in the audit');
assert.throws(() => assembleTagResult(lines, {}), /incomplete/);
const uncertain = structuredClone(answers);
uncertain.tag_kind_l3 = answer('continuation', .51);
assert.equal(assembleTagResult(lines, uncertain).records[2].kind, 'review', 'Uncertain continuation must not silently merge');
const mismatched = structuredClone(answers);
mismatched.tag_supplier_l3 = answer(`s${supplierNames.indexOf('Princess')}`);
assert.equal(assembleTagResult(lines, mismatched).records[2].kind, 'review', 'Supplier changes must not silently merge');
assert.throws(() => inputLines('x\n'.repeat(161)), /160/);
assert.throws(() => inputLines('x'.repeat(24_001)), /24,000/);
const maximum = inputLines('x'.repeat(23_682) + '\n' + Array(159).fill('y').join('\n'));
const request = buildTagRequest(maximum, maximum.slice(0, 8));
assert.ok(JSON.stringify({ model: 'jev-latest', ...request }).length < 60_000, 'Largest batch must fit proxy');
assert.equal(Object.keys(request.questions).length, 16);
const feedback = JSON.parse(feedbackBlock({ raw, result, corrected: 'My corrected deals', notes: 'Wrong supplier', rating: 'minor-fixes' }).split('\n').slice(1).join('\n'));
assert.equal(feedback.originalInput, raw);
assert.equal(feedback.correctedOutput, 'My corrected deals');
assert.equal(feedback.jevOutput, result.text);
assert.equal(feedback.decisions.length, 5);
const invalid = await onRequestPost({ request: new Request('https://example.test/api/jev', { method: 'POST', body: JSON.stringify({ state: {}, questions: { arbitrary: {} } }) }), env: { JEV_API_KEY: 'test' } });
assert.equal(invalid.status, 400);
console.log('Tagging: wrapped lines, exclusivity, uncertainty, unknown suppliers, source preservation, feedback, limits and proxy rejection passed.');
