export function buildTagPreview(records = [], decisions = []) {
  const byLine = new Map(decisions.map(row => [row.number, row]));
  const groups = new Map();
  const ignored = [];
  let offers = 0;
  let review = 0;
  for (const record of records) {
    if (record.kind === 'ignore') { ignored.push(record); continue; }
    if (record.kind === 'supplier') continue;
    const original = byLine.get(record.sourceLines?.[0]);
    const heading = original?.kind === 'supplier';
    const name = record.supplier || 'Supplier needs confirmation';
    if (!groups.has(name)) groups.set(name, { supplier: name, items: [] });
    const needsReview = record.kind === 'review';
    const exclusive = record.kind === 'exclusive' || original?.kind === 'exclusive';
    groups.get(name).items.push({ ...record, heading, needsReview, exclusive });
    if (!heading) offers++;
    if (needsReview) review++;
  }
  return { groups: [...groups.values()], ignored, offers, review };
}
