import { sameDay } from './dedupe.js';

// The matcher pre-checks identical rows; only the operator confirms them.
// Decisions are 'skip' (already on the site) or 'work' (goes to the list).
export function buildReviewQueue(categorized, decisions = {}) {
  if (!categorized) return { pending: [], skipped: [], work: [], excluded: [] };
  const queue = { pending: [], skipped: [], work: [], excluded: categorized.excluded };
  for (const row of categorized.identical) {
    const decision = decisions[row.hq.id];
    if (decision === 'work') queue.work.push(row);
    else if (decision === 'skip') queue.skipped.push(row);
    else queue.pending.push(row);
  }
  for (const row of categorized.work) {
    if (decisions[row.hq.id] === 'skip') queue.skipped.push(row);
    else queue.work.push(row);
  }
  const byVendor = (a, b) => a.hq.vendor.localeCompare(b.hq.vendor) || a.hq.id - b.hq.id;
  queue.pending.sort(byVendor);
  queue.skipped.sort(byVendor);
  queue.work.sort(byVendor);
  return queue;
}

export function dateChange(row) {
  if (row.hq.ongoing && row.web?.expiryDate) return 'Source is ongoing; website has an end date.';
  if (row.hq.end && !row.web?.expiryDate) return 'Source has an end date; website has none.';
  if (row.hq.end && row.web?.expiryDate && !sameDay(row.hq.end, row.web.expiryDate)) return 'End date differs — check the website date.';
  return '';
}
