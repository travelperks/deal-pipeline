import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
const longEmail = Array.from({ length: 1201 }, (_, i) => i % 20 === 0 ? 'Carnival' : `Offer ${i}: Save 50%, plus $100 onboard credit through November 30.`).join('\n');
assert.equal(inputLines(longEmail).length, 1201, 'Whole emails must not have a line or total-character cap');
const maximum = inputLines(longEmail);
const request = buildTagRequest(maximum, maximum.slice(0, 8));
assert.ok(JSON.stringify({ model: 'jev-latest', ...request }).length < 60_000, 'Largest batch must fit proxy');
assert.equal(Object.keys(request.questions).length, 16);
for (const email of [longEmail, ...(process.argv[2] ? [readFileSync(process.argv[2], 'utf8')] : [])]) {
  const full = inputLines(email);
  const covered = [];
  for (let i = 0; i < full.length; i += 8) {
    const batch = full.slice(i, i + 8);
    const body = buildTagRequest(full, batch, { supplier: 'Carnival', supplier_heading: 'Carnival', section_heading: 'Contemporary Cruise Offers' });
    assert.ok(JSON.stringify({ model: 'jev-latest', ...body }).length < 60_000);
    assert.ok(body.state.source_lines.length <= 28, 'Only nearby context should be repeated');
    assert.equal(body.state.prior_context.supplier, 'Carnival');
    for (const line of batch) {
      assert.ok(body.state.source_lines.some(source => source.id === line.id && source.text === line.text));
      assert.ok(body.questions[`tag_kind_${line.id}`]);
      assert.ok(body.questions[`tag_supplier_${line.id}`]);
      covered.push(line.id);
    }
  }
  assert.deepEqual(covered, full.map(line => line.id), 'Every source line must be classified exactly once');
  console.log(`Whole email accepted: ${full.length} lines; all batches below the API request limit.`);
}
const feedback = JSON.parse(feedbackBlock({ raw, result, corrected: 'My corrected deals', notes: 'Wrong supplier', rating: 'minor-fixes' }).split('\n').slice(1).join('\n'));
assert.equal(feedback.originalInput, raw);
assert.equal(feedback.correctedOutput, 'My corrected deals');
assert.equal(feedback.jevOutput, result.text);
assert.equal(feedback.decisions.length, 5);
const invalid = await onRequestPost({ request: new Request('https://example.test/api/jev', { method: 'POST', body: JSON.stringify({ state: {}, questions: { arbitrary: {} } }) }), env: { JEV_API_KEY: 'test' } });
assert.equal(invalid.status, 400);
console.log('Tagging: wrapped lines, exclusivity, uncertainty, unknown suppliers, source preservation, feedback, limits and proxy rejection passed.');
