import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildTagPreview } from '../src/logic/tagPreview.js';
import { inputLines, preclassifyLines, assembleTagResult, tagWithJev, buildTagRequest } from '../src/logic/tagJev.js';

const source = 'Carnival\nSave 50% through November 30\nEXCLUSIVE $100 onboard credit\nUnsubscribe';
const result = await tagWithJev(source, () => { throw new Error('Clear lines must not require a paid Jev call'); });
assert.equal(result.stats.jevLines, 0);
assert.equal(result.stats.localLines, 4);
const preview = buildTagPreview(result.records, result.decisions);
assert.equal(preview.groups[0].supplier, 'Carnival');
assert.equal(preview.offers, 2);
assert.equal(preview.ignored.length, 1);
assert.ok(preview.groups[0].items[1].exclusive);
const uncertain = buildTagPreview([{ kind: 'review', supplier: '', text: 'An uncertain offer', sourceLines: [1] }], [{ number: 1, kind: 'exclusive' }]);
assert.equal(uncertain.groups[0].supplier, 'Supplier needs confirmation');
assert.ok(uncertain.groups[0].items[0].needsReview);
assert.ok(uncertain.groups[0].items[0].exclusive);
assert.equal(uncertain.offers, 1);
const tricky = inputLines('Carnival\nViking\nSave 50%\nRoyal Caribbean — Free drinks\nthrough November 30');
const local = preclassifyLines(tricky);
assert.ok(!local.tag_kind_l2, 'Ambiguous supplier headings need Jev');
assert.ok(!local.tag_kind_l3, 'Unknown supplier scope must not inherit Carnival');
assert.ok(!local.tag_kind_l4, 'Mixed supplier and offer lines need Jev');
assert.ok(!local.tag_kind_l5, 'Wrapped dates need Jev');
const mixed = preclassifyLines(inputLines('Carnival\nPrincess: Save 50%'));
assert.ok(!mixed.tag_kind_l2, 'Do not assign a different supplier to the preceding heading');
if (process.argv[2]) {
  const text = readFileSync(process.argv[2], 'utf8');
  const feedback = JSON.parse(text.slice(text.indexOf('{')));
  const original = inputLines(feedback.originalInput);
  const classified = assembleTagResult(original, feedback.answers);
  const view = buildTagPreview(classified.records, classified.decisions);
  assert.equal(view.ignored.length, classified.records.filter(row => row.kind === 'ignore').length);
  assert.equal(view.groups.flatMap(group => group.items).length, classified.records.filter(row => !['supplier', 'ignore'].includes(row.kind)).length, 'Every non-heading, non-clutter record stays visible');
  const localCount = Object.keys(preclassifyLines(original)).length / 2;
  assert.ok(localCount > original.length / 2, 'Most of this real email should be handled without Jev');
  // Replay the real saved Jev answers only for questions still needed after preflight.
  const replay = await tagWithJev(feedback.originalInput, async body => Object.fromEntries(Object.keys(body.questions).map(id => {
    assert.ok(feedback.answers[id], 'Every requested question must have a recorded real answer');
    return [id, feedback.answers[id]];
  })));
  assert.equal(replay.decisions.length, original.length);
  assert.equal(replay.stats.jevLines, original.length - localCount);
  const baselineCharacters = original.reduce((total, _line, i) => i % 8 ? total : total + JSON.stringify(buildTagRequest(original, original.slice(i, i + 8))).length, 0);
  assert.ok(replay.stats.requestCharacters < baselineCharacters * .7, 'Preflight must materially reduce paid request input');
  console.log(JSON.stringify({ lines: original.length, localLines: localCount, remainingForJev: original.length - localCount, inputReductionPercent: Math.round((1 - replay.stats.requestCharacters / baselineCharacters) * 100), previewSuppliers: view.groups.length, previewOffers: view.offers, review: view.review, ignored: view.ignored.length }));
}
console.log('Finished preview preserves offers, uncertainty and exclusives; local prepass avoids paid calls for clear cases and preserves ambiguous cases for Jev.');
