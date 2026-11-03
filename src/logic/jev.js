// =============================================================================
// JEV MATCHING — DEC-07
// TypeSafe's Jev decides which website deal (if any) each incoming deal is,
// taught the operator's rules and given the typed facts code extracted. Code
// owns the facts and the hard gates: same supplier, same exclusivity, the
// ending-today exclusion, year-typo fixes, and the live-vs-update term check.
// =============================================================================

import { compareMarkers, dateFmt, runFullMatch, sameDay, exportUnmatched } from './dedupe.js';

/**
 * Every rule the project knows about "is this the same deal?", compiled from
 * the operator's calls, the matcher's offer vocabulary, past dedupe fixes and
 * criticism.md's blockers. Kept short: it rides along on every Jev request.
 * Exclusive-vs-public and ending-today are enforced in code before Jev is asked.
 */
export const RULES = [
  'Facts were extracted by code and are reliable. When `compared` says amounts or offer kinds differ, trust it over the wording.',
  'Same kind of offer (and same exclusivity) is the same deal even if the amount, percentage or end date changed: update.',
  'Offer kinds with no overlap are different deals. A specific benefit (onboard credit, gratuities, a gift, airfare, kids sail free) never matches a website deal that only promises generic discounts, savings or bonuses.',
  "If the incoming deal keeps the website deal's offer and adds more (credit, a percentage, an upgrade, an end date), it is the same deal: update. A vague website deal (\"special solo savings\", \"all-inclusive upgrade\") matches the concrete version of the same benefit (\"50% off the single supplement\", \"comp all-inclusive package\").",
  'Incoming "Ongoing" vs a website end date: the operator set that date so the listing would not run forever. Same deal: update (push the date).',
  '"Ongoing" and "no end date" mean the same thing: open-ended. Both open-ended is the same end date.',
  'Already live: same offer, same amounts, percentages and nights, same end date (or both open-ended). A website deal that has everything the incoming deal has plus a little more (wine vs wine and chocolates) is still already live.',
  'Wording never matters: website titles are marketing rewrites. Ignore promo/booking codes (PWD, BC100, LASTMINUTE), internal labels (TLN, OCAPP, LTO, GTY, PBP, PHY, P2P), "capacity controlled", "limited availability" and which sailings or tours qualify.',
  'Glossary: OBC = onboard/shipboard credit; PPG = prepaid gratuities; covert, opaque, hidden, unpublished, private fares and "cover rates" are one exclusive rate kind; named sales (Labor Day, Black Friday, Wave, Quiet Season) are savings.',
];

/** The operator's own calls, as short worked examples. */
export const EXAMPLES = [
  'EXCLUSIVE up to $250 OBC vs "EXCLUSIVE: Receive Up to $350 Onboard Credit" → update (amount changed)',
  'Save 15% LASTMINUTE, Ongoing vs "Save 15% on Last Minute Deals" ending 10/31 → update (push date)',
  '5% Savings + $200 OBC + Comp All-Inclusive Pkg vs "Get an All-Inclusive Upgrade" → update (keeps all-inclusive, adds more)',
  '50% off the Single Supplement vs "Special Solo Savings", no end date → update (same solo savings, now concrete)',
];

const STATUS = {
  live: 'Already live: a website deal is this exact deal, same terms and end date.',
  update: 'Update: a website deal is the same deal but its terms or end date need changing.',
  new: 'New: none of the website deals is this deal.',
};

const FACT_NAMES = { type: 'offer', expiry: 'ends', dollars: 'amounts', percents: 'percents', nights: 'nights' };

// How one typed fact compares between the incoming deal and a website deal.
function factStatus(check, incoming, website) {
  if (check.key === 'type') return { same: 'same kind', partial: 'partly overlap', different: 'no overlap', unknown: 'unclear' }[check.status] || check.status;
  if (check.key === 'expiry') {
    // Ongoing and no end date are the same thing: open-ended.
    if (!website.expiryDate) return incoming.ongoing || !incoming.end ? 'same (both open-ended)' : 'incoming adds an end date';
    if (incoming.ongoing) return 'incoming ongoing, website dated';
    return check.status === 'same' ? 'same' : 'different';
  }
  if (check.status === 'n/a') return 'neither states';
  if (check.status === 'same') return 'same';
  if (check.hq === '—') return 'only website states';
  if (check.web === '—') return 'only incoming states';
  return 'different';
}

function factsOf(checks, side) {
  return Object.fromEntries(checks.filter(c => FACT_NAMES[c.key]).map(c => [FACT_NAMES[c.key], c[side]]));
}

/**
 * Website deals Jev may consider for an incoming deal: same supplier family
 * (the caller's group) and same exclusivity. An exclusive deal and a public
 * one are never the same deal.
 */
export function candidatesFor(hq, webGroup) {
  return webGroup.filter(w => !!w.markers?.exclusive === !!hq.markers?.exclusive);
}

/** One Jev request: the incoming deal, each candidate with typed facts and how they compare, and the rules. */
export function buildJevRequest(hq, candidates, today = new Date(), note = '') {
  const checksFor = candidates.map(w => compareMarkers(hq, w).checks);
  const websiteDeals = Object.fromEntries(candidates.map((w, i) => [`w${i + 1}`, {
    title: w.raw?.title || '',
    description: w.raw?.shopListing || '',
    facts: factsOf(checksFor[i], 'web'),
    compared: Object.fromEntries(checksFor[i].filter(c => FACT_NAMES[c.key]).map(c => [FACT_NAMES[c.key], factStatus(c, hq, w)])),
  }]));
  const match = Object.fromEntries(candidates.map((w, i) => [`w${i + 1}`, w.raw?.title || `website deal ${i + 1}`]));
  match.none = 'None of them.';
  return {
    state: {
      today: dateFmt.format(today),
      incoming_deal: { text: hq.text, facts: factsOf(checksFor[0] || [], 'hq') },
      website_deals: websiteDeals,
      rules: RULES,
      examples: EXAMPLES,
      ...(note ? { operator_note: note } : {}),
    },
    questions: {
      status: { type: 'choice', instructions: 'Following `rules`, is `incoming_deal` already live, an update to one of `website_deals`, or new?', criteria: STATUS },
      match: { type: 'choice', instructions: 'Following `rules`, which of `website_deals` is the same deal as `incoming_deal`?', criteria: match },
    },
  };
}

const FIGURE_KEYS = ['dollars', 'percents', 'nights', 'expiry'];

// Matching numbers alone do not prove identity. They do justify operator review
// when Jev says "new", especially if the only barrier is an exclusivity label.
function matchingTerms(hq, websiteDeals) {
  return websiteDeals.filter(web => {
    const pair = compareMarkers(hq, web);
    const sharedFigure = ['dollars', 'percents'].some(key => hq.markers[key]?.size && web.markers[key]?.size && pair.checks.find(c => c.key === key)?.status === 'same');
    const sameEnd = hq.end && web.expiryDate ? sameDay(hq.end, web.expiryDate) : !hq.end && !web.expiryDate;
    return sharedFigure && sameEnd && pair.checks.find(c => c.key === 'type')?.status !== 'different' && FIGURE_KEYS.every(key => !pair.differences.includes(key));
  });
}

function requireReview(result, candidates, reason) {
  const existing = result.meta.ranked || [];
  return { ...result, meta: { ...result.meta, reviewReason: reason, reviewCandidates: candidates, ranked: [
    ...candidates.map(web => existing.find(row => row.web === web) || { web, p: null }),
    ...existing.filter(row => !candidates.includes(row.web)),
  ] } };
}

/**
 * Turns Jev's two answers into a comparison result. Jev decides whether the
 * deal is on the site and which entry it is; when Jev says update/live but
 * names no entry, the likeliest entry is used. A matched deal is live only
 * when Jev says so and every stated term agrees. `ranked` lists candidates
 * by Jev's match probability so the operator can step to the next one.
 */
export function combineJevAnswer(hq, candidates, answers) {
  const status = answers.status;
  const match = answers.match;
  const ranked = Object.entries(match.probabilities || {})
    .filter(([id]) => id !== 'none')
    .sort((a, b) => b[1] - a[1])
    .map(([id, p]) => ({ index: Number(id.slice(1)) - 1, p }))
    .filter(r => r.index >= 0 && r.index < candidates.length);
  let target = match.choice === 'none' ? -1 : Number(String(match.choice).slice(1)) - 1;
  if (status.choice !== 'new' && !(target >= 0 && target < candidates.length)) target = ranked.length ? ranked[0].index : -1;
  const sp = status.probabilities || {};
  const pNew = sp.new ?? (status.choice === 'new' ? status.confidence ?? 0 : 0);
  const base = { source: 'jev', candidates, ranked: ranked.map(r => ({ web: candidates[r.index], p: r.p })), reconsidered: !!answers.reconsidered };
  if (status.choice === 'new' || target < 0) {
    // Sure it is new = sure it is new AND no website deal looks like a match.
    const confidence = Math.min(pNew, 1 - (ranked[0]?.p ?? 0));
    const result = { hq, web: null, meta: { ...base, verdict: 'new', confidence, changes: [] } };
    const conflicts = matchingTerms(hq, candidates);
    return conflicts.length ? requireReview(result, conflicts, 'matching-terms') : result;
  }
  const web = candidates[target];
  const pair = compareMarkers(hq, web);
  // Live vs update comes from the facts. When every stated term agrees the
  // deal is live unless Jev is clearly sure something extra is offered that
  // the facts cannot name (e.g. "2-for-1 fares").
  const termsEqual = FIGURE_KEYS.every(k => !pair.differences.includes(k));
  const verdict = termsEqual && (sp.update ?? (status.choice === 'update' ? 1 : 0)) < 0.7 ? 'on-site' : 'update';
  // Sure of the match = sure it is this website deal AND that it is not new.
  const matchP = ranked.find(r => r.index === target)?.p ?? match.confidence ?? 0;
  const confidence = Math.min(matchP, 1 - pNew);
  return { hq, web, meta: { ...pair, ...base, verdict, guess: false, confidence, jevStatus: status.choice } };
}

/** Calls the operator needs to look at: Jev unsure, Jev unavailable. Everything else is skim-only. */
export const REVIEW_BELOW = 0.8;
export function needsReview(row) {
  if (row.meta?.jevSkipped) return false;
  if (row.meta?.reviewReason) return true;
  if (!row.meta?.candidates?.length) return false;
  return !!row.meta.jevError || (row.meta.confidence ?? 0) < REVIEW_BELOW;
}

async function pool(items, size, work) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(size, queue.length) }, async () => {
    while (queue.length) await work(queue.shift());
  }));
}

function groupByFamily(websiteDeals) {
  const byFamily = {};
  for (const w of websiteDeals) (byFamily[w.vendorFamily] ||= []).push(w);
  return byFamily;
}

function validAnswer(answer) {
  return ['new', 'update', 'live'].includes(answer?.status?.choice) && /^(none|w\d+)$/.test(answer?.match?.choice || '');
}

export function pendingJevDeals(hqDeals, websiteDeals, cache = {}, today = new Date()) {
  const byFamily = groupByFamily(websiteDeals);
  return hqDeals.filter(hq => candidatesFor(hq, byFamily[hq.vendorFamily] || []).length && !sameDay(hq.end, today) && !validAnswer(cache?.[hq.id]));
}

/**
 * Compares every incoming deal with Jev. `call(body)` sends one request and
 * resolves to Jev's `answers`. Only deals with a same-exclusivity candidate
 * that are not ending today are sent, to keep calls minimal. Deals Jev could
 * not answer keep the rule-based verdict, marked `jevError`. `cache` maps
 * hq id → answers already received.
 */
export async function compareWithJev(hqDeals, websiteDeals, call, { today = new Date(), cache = {}, concurrency = 2, retryDelayMs = 400, onProgress = (_done, _total) => {} } = {}) {
  const ruleResults = runFullMatch(hqDeals, websiteDeals);
  const byFamily = groupByFamily(websiteDeals);
  const answers = { ...cache };
  const todo = pendingJevDeals(hqDeals, websiteDeals, answers, today);
  let done = hqDeals.length - todo.length;
  onProgress(done, hqDeals.length);
  await pool(todo, concurrency, async (hq) => {
    delete answers[hq.id];
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const answer = await call(buildJevRequest(hq, candidatesFor(hq, byFamily[hq.vendorFamily]), today));
        if (!validAnswer(answer)) throw new Error('Incomplete Jev answer');
        answers[hq.id] = answer;
        break;
      } catch (error) {
        // Retry only an unanswered request, never a successful paid decision.
        const permanent = error?.status >= 400 && error.status < 500 && ![408, 429].includes(error.status);
        if (attempt || permanent) break;
        await new Promise(resolve => setTimeout(resolve, retryDelayMs));
      }
    }
    onProgress(++done, hqDeals.length);
  });
  return { answers, results: applyJevAnswers(ruleResults, websiteDeals, answers, today) };
}

/** Re-applies stored Jev answers to rule-based results (no network). */
export function applyJevAnswers(ruleResults, websiteDeals, answers, today = new Date()) {
  const byFamily = groupByFamily(websiteDeals);
  return ruleResults.map((result) => {
    const family = byFamily[result.hq.vendorFamily] || [];
    const candidates = candidatesFor(result.hq, family);
    const crossExclusive = matchingTerms(result.hq, family.filter(web => !!web.markers.exclusive !== !!result.hq.markers.exclusive));
    if (!candidates.length) {
      const unmatched = { hq: result.hq, web: null, meta: { verdict: 'new', changes: [], candidates: [], ranked: [] } };
      return crossExclusive.length && !sameDay(result.hq.end, today) ? requireReview(unmatched, crossExclusive, 'exclusivity-mismatch') : unmatched;
    }
    const got = answers[result.hq.id];
    if (!validAnswer(got)) {
      if (sameDay(result.hq.end, today)) {
        // The initial batch deliberately skips these. Already-live ones remain
        // in the summary, so they must not masquerade as failed Jev requests.
        return { ...result, meta: { ...result.meta, source: 'rules', jevSkipped: 'ending-today', candidates, ranked: [] } };
      }
      return { ...result, meta: { ...result.meta, jevError: true, candidates, ranked: candidates.map(web => ({ web, p: null })) } };
    }
    const combined = combineJevAnswer(result.hq, candidates, got);
    return combined.meta.verdict === 'new' && crossExclusive.length ? requireReview(combined, crossExclusive, 'exclusivity-mismatch') : combined;
  });
}

/**
 * Asks Jev again about one deal, telling it the operator doubts its call.
 * Resolves to the new answers, marked `reconsidered`.
 */
export async function reconsiderWithJev(hq, websiteDeals, doubted, call, today = new Date()) {
  const candidates = candidatesFor(hq, websiteDeals.filter(w => w.vendorFamily === hq.vendorFamily));
  const note = doubted
    ? `The operator doubts that "${doubted.raw?.title}" is the same deal. Re-check every fact before answering; it may be another website deal or new.`
    : 'The operator doubts this deal is new. Re-check every fact against each website deal before answering.';
  return { ...(await call(buildJevRequest(hq, candidates, today, note))), reconsidered: true };
}

/**
 * Applies the operator's review: `decisions` maps hq id → { verdict, web },
 * where `web` indexes `websiteDeals`. The operator's call always wins.
 */
export function applyDecisions(results, decisions, websiteDeals) {
  return results.map((r) => {
    const d = decisions[r.hq.id];
    if (!d) return r;
    const web = d.verdict === 'new' ? null : (d.web != null ? websiteDeals[d.web] : r.web);
    if (d.verdict !== 'new' && !web) return r;
    const pair = web ? compareMarkers(r.hq, web) : { changes: [] };
    return { ...r, web, meta: { ...r.meta, ...pair, verdict: d.verdict, reviewed: true } };
  });
}

/** The Publish boundary: every uncertain call must have an explicit decision. */
export function buildPublishHandoff(categorized) {
  const all = [...categorized.update, ...categorized.added, ...categorized.onSite];
  if (all.some(row => !row.meta?.reviewed && needsReview(row))) return null;
  const rows = [...categorized.update, ...categorized.added];
  if (!rows.length) return null;
  return {
    text: exportUnmatched(rows.map(row => row.hq)),
    actions: [
      ...categorized.update.map(row => ({ vendor: row.hq.vendor, text: row.hq.text, action: 'update', websiteTitle: row.web?.raw?.title || '' })),
      ...categorized.added.map(row => ({ vendor: row.hq.vendor, text: row.hq.text, action: 'new', websiteTitle: '' })),
    ],
  };
}
