// =============================================================================
// DEDUPE LOGIC — ported from dedupe/index.html
// Bug fixes applied:
//   1. Viking familyOf ordering — fixed in shared suppliers.js
//   2. Supplier list drift — eliminated by using shared suppliers.js
//   3. parseYear — handles garbage input, returns null instead of NaN
// =============================================================================

import { norm, resolveVendor } from './suppliers.js';

// --- Date parsing ---

function parseYear(y) {
  if (!y) return null;
  // BUG FIX: Strip non-digit characters and validate
  const cleaned = y.replace(/\D/g, '');
  if (!cleaned) return null; // pure garbage like "q7"
  let n = +cleaned;
  if (isNaN(n)) return null;
  if (cleaned.length <= 2) n = n >= 70 ? 1900 + n : 2000 + n;
  return n;
}

function toLA(m, d, y) { return new Date(y, m - 1, d, 12, 0, 0); }
function startOfDay(d) { const x = new Date(d); x.setHours(0,0,0,0); return x; }
function endOfDay(d) { const x = new Date(d); x.setHours(23,59,59,999); return x; }

/** Compares two present dates by local calendar day rather than timestamp. */
export function sameDay(a, b) {
  return !!(a && b) &&
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
}

/**
 * Extracts the booking window encoded in terse HQ deal text using Los Angeles
 * calendar semantics. Ongoing offers have no end date, malformed years become
 * `dateWarning` evidence instead of guessed dates, and an omitted year rolls
 * forward only when the inferred date would otherwise already be past.
 */
export function parseHQDates(text) {
  const t = text.toLowerCase();
  const out = { start: null, end: null, ongoing: false, dateWarning: null };

  if (/ongoing/.test(t)) { out.ongoing = true; return out; }
  if (/today/.test(t)) { out.end = endOfDay(new Date()); return out; }

  const range = t.match(
    /(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\s*[-–]\s*(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/
  );
  if (range) {
    let y2 = parseYear(range[6]);
    let y1 = parseYear(range[3] ?? range[6]);
    if ((range[3] && y1 === null) || (range[6] && y2 === null)) {
      out.dateWarning = `Could not parse year in date range: "${range[0]}"`;
      return out;
    }
    if (y2 === null) {
      // No year written: assume the current year, rolling forward only when
      // the end date would otherwise already be past.
      const now = new Date().getFullYear();
      const tent = toLA(+range[4], +range[5], now);
      y2 = tent < startOfDay(new Date()) ? now + 1 : now;
    }
    if (y1 === null) y1 = y2;
    out.start = toLA(+range[1], +range[2], y1);
    out.end = endOfDay(toLA(+range[4], +range[5], y2));
    return out;
  }

  const single = t.match(/ends?\s+(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
  if (single) {
    let y = parseYear(single[3]);
    if (single[3] && y === null) {
      out.dateWarning = `Possible typo in year: "${single[3]}" in "${single[0]}"`;
      return out;
    }
    if (!single[3] || y === null) {
      const tent = toLA(+single[1], +single[2], new Date().getFullYear());
      y = tent < startOfDay(new Date()) ? new Date().getFullYear() + 1 : new Date().getFullYear();
    }
    out.end = endOfDay(toLA(+single[1], +single[2], y));
    return out;
  }

  const any = [...t.matchAll(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/g)];
  if (any.length) {
    const last = any[any.length - 1];
    const y = parseYear(last[3]);
    if (last[3] && y === null) {
      out.dateWarning = `Possible typo in year: "${last[3]}"`;
      return out;
    }
    out.end = endOfDay(toLA(+last[1], +last[2], y || new Date().getFullYear()));
  }
  return out;
}

/** Shared Los Angeles date formatter used by the operator-facing match UI. */
export const dateFmt = new Intl.DateTimeFormat("en-US", {
  year: "numeric", month: "2-digit", day: "2-digit", timeZone: "America/Los_Angeles",
});

// --- Marker extraction ---

// A deal is described by a small set of markers the operator checks by eye:
// the kind of offer, exclusivity, the money/percent/night figures, and the
// expiry. Text similarity is deliberately not one of them.
const TYPE_PATTERNS = [
  ["gratuities", /\bppgs?\b|prepaid\s*gratuit|free\s*gratuit|gratuit/i],
  ["obc", /\bobcs?\b|on\s*board\s*credit|shipboard\s*credit|onboard\s*spending|\bbar\s*tab/i],
  ["covert", /\bcove?rt?\s*(rates?|fares?|pricing|savings?)|\bcovert\b|too\s*low\s*to\s*show|hidden|secret|opaque|private\s*sale|unadvertised/i],
  ["kids-free", /kids?\s*(sail|stay|travel)\s*free|kids?\s*free/i],
  ["instant-savings", /instant\s*(savings?|credit)/i],
  ["upgrade", /\b\d*-?\s*cat(egory)?\s*upgrade|\bupgrade|\bbalcony\s*(stateroom|room)?\s*(at|for)\s*oceanview|oceanview\s*(at|for)\s*inside/i],
  ["drinks-wifi", /(drinks?|beverage|bev\s*pkg|cheers)\b.*wi[\s-]*fi|wi[\s-]*fi.*(drinks?|beverage)|drinks?\s*(package|pkg)|beverage\s*package|free\s*wi[\s-]*fi/i],
  ["airfare", /\bair\s*credit|\bbogo\s*air|\bair\s*fare|\bfree\s*air|\bairfare|\bfree\s*flights?|\breduced\s*air/i],
  ["multi-guest", /2nd\s*guest|second\s*guest|3rd\s*(\/|and|&)?\s*4th|third\s*(and|&)\s*fourth|extra\s*guests?|additional\s*guests?|guests?\s*(sail|fly|stay)\s*free|for\s*cabins?\s*\d/i],
  ["dining", /specialty\s*din|free\s*din|tamarind\s*din|canaletto\s*din|dining\s*(credit|package)|free\s*(meals?|lunch|dinner)/i],
  ["coupon", /coupon\s*booklet|savings?\s*coupon|\bbooklet\b/i],
  ["gift", /\b(bottle|wine|champagne|prosecco|chocolates?|flowers?|gifts?|welcome\s*basket)\b/i],
  ["perks", /\bperk(?:s)?\b(?!.*\bno\s*perk)|free\s*at\s*sea|amenit/i],
  ["freebie", /\bcomplimentary\b|\bfree\b|\bbonus\b/i],
  ["no-perk", /\bno\s*perk|perk[\s-]*free/i],
  ["deposit", /reduced\s*deposit|deposit\s*(sale|special)|low\s*deposit|\$\s*\d+\s*deposit|(\d+)%\s*deposit/i],
  ["shore-ex", /shore\s*ex|shore\s*excursion|excursion\s*credit/i],
  ["spa", /spa\s*credit/i],
  ["military", /military|veteran/i],
  ["resident", /resident\s*rate|residents?\b.*\brate|florida.*resident|georgia.*resident/i],
  ["loyalty", /double\s*points|bonus\s*points|loyalty|crown\s*&?\s*anchor|captain.?s\s*club|latitudes|mariner|venetian\s*society|past\s*guest|repeat\s*guest|cruisefirst/i],
  ["all-inclusive", /all[\s-]*inclusive|bundled|always\s*included/i],
  ["named-sale", /\b(labor\s*day|memorial\s*day|black\s*friday|cyber|holiday|summer|fall|winter|spring|anniversary|birthday|wave|flash|triple\s*play|early\s*saver)\b.*\b(sale|savings?|event|deals?|rates?)|\b(sale|savings?|event)\b.*\b(labor\s*day|memorial\s*day|black\s*friday|cyber|holiday|anniversary)/i],
  ["savings", /\bsav(e|ings?)\b|\d\s*%\s*off|\$\s*[\d,]+\s*off|discount|reduced\s*(rates?|fares?|pricing)|low(er|est)?\s*(rates?|fares?)|great\s*rates?|\bfares?\s*from|\bfrom\s*\$/i],
];

// Generic sale/savings wording is dropped when a concrete kind of offer is
// present, so "Labor Day Sale: 40% off + upgrade" reads as savings + upgrade
// on both sides regardless of how the website copy was phrased.
const GENERIC_TYPES = new Set(["savings", "named-sale", "perks", "freebie"]);

function extractMarkers(text, { exclusive = false } = {}) {
  const types = new Set();
  for (const [tag, re] of TYPE_PATTERNS) {
    if (re.test(text)) types.add(tag);
  }
  if (types.has("named-sale")) { types.delete("named-sale"); types.add("savings"); }
  const specific = [...types].filter(t => !GENERIC_TYPES.has(t));
  if (specific.length || types.has("savings")) { types.delete("perks"); types.delete("freebie"); }
  else if (types.has("perks")) types.delete("freebie");
  // Savings paired with a concrete perk is common ("save + OBC") and is kept;
  // savings alone is its own kind.

  // Dollar, euro and pound figures share one set; the currency symbol is not
  // a marker on its own, only the figures are.
  const dollars = new Set();
  for (const m of text.matchAll(/(?:[$€£]\s*([\d,]+))|(?:\b([\d,]+)\s*(?:euros?|pounds?|usd|eur|gbp)\b)/gi)) {
    const val = parseInt((m[1] || m[2]).replace(/,/g, ''), 10);
    if (val > 0 && val < 100000) dollars.add(val);
  }

  const percents = new Set();
  for (const m of text.matchAll(/(\d{1,3})\s*%/g)) {
    const val = parseInt(m[1], 10);
    if (val > 0 && val <= 100) percents.add(val);
  }

  const nights = new Set();
  for (const m of text.matchAll(/\b(\d{1,2})\s*[-–]?\s*(?:nights?|nts?)\b/gi)) {
    nights.add(parseInt(m[1], 10));
  }

  const isExclusive = exclusive || types.has("covert") || /\[exclusive\]|\bexclusive\b|\btln\b/i.test(text);

  return { types, exclusive: isExclusive, dollars, percents, nights };
}

// --- Marker comparison ---

const MARKER_LABELS = {
  type: 'Type of offer',
  exclusive: 'Exclusive',
  expiry: 'Expiry',
  dollars: 'Amounts',
  percents: 'Percentages',
  nights: 'Nights',
};

const TYPE_LABELS = {
  gratuities: 'Free gratuities', obc: 'Onboard credit', covert: 'Covert rate',
  'kids-free': 'Kids free', 'instant-savings': 'Instant savings', upgrade: 'Upgrade',
  'drinks-wifi': 'Drinks / Wi-Fi', airfare: 'Airfare', 'multi-guest': 'Multi-guest discount',
  dining: 'Dining', coupon: 'Coupon booklet', perks: 'Perks', 'no-perk': 'No-perk rate',
  gift: 'Gift', freebie: 'Something free',
  deposit: 'Deposit', 'shore-ex': 'Shore excursions', spa: 'Spa', military: 'Military',
  resident: 'Resident rate', loyalty: 'Loyalty', 'all-inclusive': 'All-inclusive',
  savings: 'Savings',
};
export function describeTypes(types) {
  return [...types].map(t => TYPE_LABELS[t] || t).join(' + ') || 'Unrecognized';
}

function setsEqual(a, b) {
  return a.size === b.size && [...a].every(v => b.has(v));
}
function fmtSet(set, prefix = '', suffix = '') {
  return [...set].sort((a, b) => a - b).map(v => `${prefix}${v.toLocaleString('en-US')}${suffix}`).join(', ');
}

function compareTypes(hqTypes, webTypes) {
  if (!hqTypes.size && !webTypes.size) return 'unknown';
  if (setsEqual(hqTypes, webTypes)) return 'same';
  // Website copy often adds generic "savings" wording around a concrete perk;
  // when both sides name the same concrete kinds, that wording is noise.
  const hqSpecific = new Set([...hqTypes].filter(t => !GENERIC_TYPES.has(t)));
  const webSpecific = new Set([...webTypes].filter(t => !GENERIC_TYPES.has(t)));
  if (hqSpecific.size && setsEqual(hqSpecific, webSpecific)) return 'same';
  const overlap = [...hqTypes].filter(t => webTypes.has(t));
  if (!overlap.length) return 'different';
  return 'partial';
}

function compareSets(a, b) {
  if (!a.size && !b.size) return 'n/a';
  if (setsEqual(a, b)) return 'same';
  return 'different';
}

function compareExpiry(hq, web) {
  if (hq.ongoing) return web.expiryDate ? 'different' : 'same';
  if (!hq.end && !web.expiryDate) return 'n/a';
  if (!hq.end || !web.expiryDate) return 'different';
  return sameDay(hq.end, web.expiryDate) ? 'same' : 'different';
}

/**
 * Compares one incoming deal with one website deal marker by marker. The
 * result is a checklist in the operator's order, an internal rank used only to
 * pick the best sibling per supplier, and `identical` when nothing differs.
 */
function compareMarkers(hq, web) {
  const H = hq.markers, W = web.markers;
  const typeStatus = compareTypes(H.types, W.types);
  const checks = [
    { key: 'type', status: typeStatus, hq: describeTypes(H.types), web: describeTypes(W.types) },
    { key: 'exclusive', status: H.exclusive === W.exclusive ? 'same' : 'different', hq: H.exclusive ? 'Yes' : 'No', web: W.exclusive ? 'Yes' : 'No' },
    { key: 'expiry', status: compareExpiry(hq, web), hq: hq.ongoing ? 'Ongoing' : hq.end ? dateFmt.format(hq.end) : '—', web: web.expiryDate ? dateFmt.format(web.expiryDate) : 'None' },
    { key: 'dollars', status: compareSets(H.dollars, W.dollars), hq: fmtSet(H.dollars, '$') || '—', web: fmtSet(W.dollars, '$') || '—' },
    { key: 'percents', status: compareSets(H.percents, W.percents), hq: fmtSet(H.percents, '', '%') || '—', web: fmtSet(W.percents, '', '%') || '—' },
    { key: 'nights', status: compareSets(H.nights, W.nights), hq: fmtSet(H.nights, '', ' nights') || '—', web: fmtSet(W.nights, '', ' nights') || '—' },
  ].map(c => ({ ...c, label: MARKER_LABELS[c.key] }));

  const by = Object.fromEntries(checks.map(c => [c.key, c.status]));
  const sameKind = typeStatus === 'same' || (typeStatus === 'unknown' && by.dollars === 'same');
  const sibling = sameKind || typeStatus === 'partial';

  // Rank only decides which website deal is shown beside the incoming one.
  let rank = 0;
  if (typeStatus === 'same') rank += 100;
  else if (typeStatus === 'partial') rank += 50;
  else if (typeStatus === 'unknown') rank += 10;
  if (by.exclusive === 'same') rank += 20; else rank -= 20;
  for (const k of ['dollars', 'percents', 'nights']) {
    if (by[k] === 'same') rank += 15;
    else if (by[k] === 'different') rank -= 10;
  }
  if (by.expiry === 'same') rank += 10;
  else if (hq.end && web.expiryDate) {
    const days = Math.abs(Math.round((hq.end - web.expiryDate) / 86400000));
    if (days <= 90) rank += 3;
  }

  const identical = sameKind && checks.every(c => c.status === 'same' || c.status === 'n/a' || (c.key === 'type' && c.status === 'unknown'));
  const differences = checks.filter(c => c.status === 'different').map(c => c.key);

  return {
    score: sibling ? Math.max(rank, 1) : 0,
    identical,
    sibling,
    typeStatus,
    checks,
    differences,
    candidateRankings: [],
  };
}

function buildEmptyMeta(overrides = {}) {
  return {
    score: 0,
    identical: false,
    sibling: false,
    typeStatus: 'none',
    checks: [],
    differences: [],
    candidateRankings: [],
    ...overrides,
  };
}

function buildCandidateRankings(matrixRow, webGroup) {
  if (!matrixRow || !webGroup?.length) return [];
  return matrixRow
    .map((meta, index) => ({
      title: webGroup[index]?.raw?.title || webGroup[index]?.text || '',
      score: meta.score,
      identical: meta.identical,
      types: describeTypes(webGroup[index]?.markers?.types || new Set()),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}

function attachCandidateRankings(meta, matrixRow, webGroup) {
  return { ...meta, candidateRankings: buildCandidateRankings(matrixRow, webGroup) };
}

// Saved decisions belong to the candidate assignments produced by this version.
export const MATCHER_VERSION = 3;

// --- Assignment with an independent no-match option for every incoming deal ---

export function assignCandidateMatrix(matrix, n, m) {
  const size = n + m;
  const cost = [];
  for (let i = 0; i < size; i++) {
    cost[i] = [];
    for (let j = 0; j < size; j++) {
      cost[i][j] = (i < n && j < m) ? -matrix[i][j].score : 0;
    }
  }

  const u = new Array(size + 1).fill(0);
  const v = new Array(size + 1).fill(0);
  const p = new Array(size + 1).fill(0);
  const way = new Array(size + 1).fill(0);

  for (let i = 1; i <= size; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(size + 1).fill(Infinity);
    const used = new Array(size + 1).fill(false);
    do {
      used[j0] = true;
      let i0 = p[j0], delta = Infinity, j1;
      for (let j = 1; j <= size; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= size; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; }
        else { minv[j] -= delta; }
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }

  const result = [];
  const assigned = new Array(n).fill(-1);
  for (let j = 1; j <= size; j++) {
    if (p[j] > 0 && p[j] <= n && j <= m && matrix[p[j] - 1][j - 1].score > 0) assigned[p[j] - 1] = j - 1;
  }
  for (let i = 0; i < n; i++) result.push([i, assigned[i]]);
  return result;
}

function greedyMatch(hqGroup, webGroup, matrix) {
  const usedWeb = new Set();
  const results = [];
  const candidates = [];
  for (let i = 0; i < hqGroup.length; i++) {
    for (let j = 0; j < webGroup.length; j++) {
      candidates.push({ i, j, meta: matrix[i][j] });
    }
  }
  candidates.sort((a, b) => b.meta.score - a.meta.score);
  const assignedHQ = new Set();
  const assignment = new Map();
  for (const c of candidates) {
    if (assignedHQ.has(c.i) || usedWeb.has(c.j)) continue;
    if (c.meta.score > 0) {
      assignment.set(c.i, { webIdx: c.j, meta: c.meta });
      assignedHQ.add(c.i);
      usedWeb.add(c.j);
    }
  }
  for (let i = 0; i < hqGroup.length; i++) {
    const a = assignment.get(i);
    results.push({
      hq: hqGroup[i],
      web: a ? webGroup[a.webIdx] : null,
      meta: attachCandidateRankings(a ? a.meta : buildEmptyMeta(), matrix[i], webGroup),
    });
  }
  return results;
}

function optimalMatch(hqGroup, webGroup) {
  const n = hqGroup.length, m = webGroup.length;
  const matrix = [];
  for (let i = 0; i < n; i++) {
    matrix[i] = [];
    for (let j = 0; j < m; j++) {
      matrix[i][j] = compareMarkers(hqGroup[i], webGroup[j]);
    }
  }
  if (n <= 20 && m <= 20) {
    const assignment = assignCandidateMatrix(matrix, n, m);
    return assignment.map(([i, j]) => ({
      hq: hqGroup[i],
      web: j !== -1 ? webGroup[j] : null,
      meta: attachCandidateRankings(j !== -1 ? matrix[i][j] : buildEmptyMeta(), matrix[i], webGroup),
    }));
  }
  return greedyMatch(hqGroup, webGroup, matrix);
}

// --- HQ Parser ---

let nextId = 0;
/** Resets batch-local HQ identifiers before reparsing frozen source text. */
export function resetIds() { nextId = 0; }

function cleanTaggedContent(value) {
  return value
    .replace(/^(?:â€¢|•|\u2022)\s*/, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function looksLikeDealContent(value) {
  return /\$|\d\s*%|\b(?:ends?|ongoing|sale|save|savings|off|free|credit|deposit|rates?|package|promo|upgrade|groups?)\b/i.test(value);
}

/**
 * Parses tagged source text into normalized HQ deal records for matching.
 * Vendor context comes only from accepted `v` lines; terminal `X` exclusions
 * are ignored. Deal records retain the original line, supplier resolution
 * status, dates, exclusivity, and the markers used for comparison.
 */
export function parseHQ(text) {
  const lines = (text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const items = [];
  let currentVendor = null;
  let currentVendorResolution = null;

  for (const line of lines) {
    const m = line.match(/^([ve]d?|V|D|ED|X)\s*\t\s*(.+)$/i);
    if (!m) continue;
    const tag = m[1].toLowerCase();
    const content = cleanTaggedContent(m[2]);

    if (tag === 'v') {
      currentVendorResolution = resolveVendor(content.replace(/:$/, ''));
      currentVendor = currentVendorResolution.canonicalName || content.replace(/:$/, '').trim();
    } else if (tag === 'x') {
      // X is a terminal exclusion from Tag. A vendor-shaped X also ends the
      // current accepted supplier block so later malformed rows cannot inherit
      // the previous supplier accidentally.
      if (!looksLikeDealContent(content)) {
        currentVendorResolution = null;
        currentVendor = null;
      }
      continue;
    } else {
      if (!currentVendor) continue;
      const type = tag === 'ed' ? 'exclusive' : 'deal';
      const dates = parseHQDates(content);
      const markers = extractMarkers(content, { exclusive: type === 'exclusive' });
      items.push({
        id: ++nextId,
        type,
        vendor: currentVendor,
        vendorFamily: currentVendorResolution?.familyKey || norm(currentVendor),
        vendorStatus: currentVendorResolution?.status || 'unknown',
        vendorCandidates: currentVendorResolution?.candidates || [currentVendor],
        text: content,
        originalLine: line,
        start: dates.start,
        end: dates.end,
        ongoing: dates.ongoing,
        dateWarning: dates.dateWarning,
        markers,
      });
    }
  }
  return items;
}

// --- Website JSON ingest ---

/**
 * Adapts validated website-export rows into the comparison shape used by the
 * matcher. It preserves each raw row while normalizing supplier identity,
 * family, dates, display text, and feature evidence; schema acceptance belongs
 * to the upstream website-export validator rather than this adapter.
 */
export function ingestWebsiteJSON(arr) {
  return (arr || []).map(row => {
    const supplier = row.shopOverline || '';
    const resolution = resolveVendor(supplier);
    const vendor = resolution.canonicalName || supplier.trim();
    const family = resolution.familyKey || norm(vendor);
    const expiry = row.expiryDate ? new Date(row.expiryDate) : null;
    const post = row.postDate ? new Date(row.postDate) : null;
    const text = [row.title || '', row.shopListing || ''].join(' · ');
    const markers = extractMarkers(text);
    return {
      raw: row,
      supplier: vendor,
      supplierStatus: resolution.status,
      supplierCandidates: resolution.candidates,
      vendorFamily: family,
      expiryDate: expiry,
      postDate: post,
      text,
      markers,
    };
  });
}

// --- Full matching pipeline ---

/**
 * Builds supplier-family candidate pools and assigns each HQ deal at most one
 * website candidate using the staged scoring and optimal-matching policy.
 * Missing website candidates remain explicit unmatched results, and an optional
 * supplier filter narrows HQ work without changing the candidate evidence.
 */
export function runFullMatch(hqDeals, websiteDeals, { filterSupplier = '' } = {}) {
  const filterResolution = filterSupplier ? resolveVendor(filterSupplier) : null;
  const filterName = filterResolution?.canonicalName || filterSupplier;
  const hqByFamily = {};
  for (const hq of hqDeals) {
    if (filterName && hq.vendor !== filterName) continue;
    const fam = hq.vendorFamily;
    if (!hqByFamily[fam]) hqByFamily[fam] = [];
    hqByFamily[fam].push(hq);
  }

  const webByFamily = {};
  for (const w of websiteDeals) {
    const fam = w.vendorFamily;
    if (!webByFamily[fam]) webByFamily[fam] = [];
    webByFamily[fam].push(w);
  }

  const allResults = [];
  for (const fam of Object.keys(hqByFamily)) {
    const hqGroup = hqByFamily[fam];
    const webGroup = webByFamily[fam] || [];
    if (webGroup.length === 0) {
      for (const hq of hqGroup) {
        allResults.push({
          hq, web: null,
          meta: buildEmptyMeta({ noWebDeals: true }),
        });
      }
    } else {
      allResults.push(...optimalMatch(hqGroup, webGroup));
    }
  }
  return allResults;
}

/**
 * Partitions comparison results into two operator outcomes: `identical` rows
 * (every marker agrees with a website deal, pre-checked as already on the
 * site) and `work` rows (everything else: new deals, extensions, changed
 * terms, or a row the operator pulled back). The optional ending-today rule
 * is terminal and never reaches the Copy payload.
 */
export function categorizeDedupeResults(
  results,
  {
    excludedHQIds = [],
    excludeEndingToday = false,
    today = new Date(),
  } = {},
) {
  const pulledBack = new Set(excludedHQIds);
  const identical = [];
  const work = [];
  const excluded = [];

  for (const result of results || []) {
    if (excludeEndingToday && sameDay(result.hq.end, today) && !result.meta?.identical) {
      excluded.push({ ...result, exclusionReason: 'ending-today' });
      continue;
    }
    if (pulledBack.has(result.hq.id)) {
      work.push({ ...result, meta: { ...result.meta, operatorRejectedMatch: true } });
      continue;
    }
    if (result.web && result.meta?.identical) identical.push(result);
    else work.push(result);
  }

  const byVendor = (a, b) => a.hq.vendor.localeCompare(b.hq.vendor) || a.hq.id - b.hq.id;
  identical.sort(byVendor);
  work.sort(byVendor);

  return {
    identical,
    work,
    excluded,
    total: (results || []).length,
    today,
  };
}

// --- Export unmatched as tagged text ---

/**
 * Serializes reviewed unmatched HQ records back to canonical tagged text for
 * the Copy step, preserving exclusivity and grouping suppliers alphabetically.
 */
export function exportUnmatched(deals) {
  const grouped = {};
  deals.forEach(d => {
    if (!grouped[d.vendor]) grouped[d.vendor] = [];
    grouped[d.vendor].push(d);
  });
  let output = '';
  Object.keys(grouped).sort().forEach(v => {
    output += `v\t${v}\n`;
    grouped[v].forEach(d => {
      const tag = d.type === 'exclusive' ? 'ed' : 'd';
      output += `${tag}\t${d.text}\n`;
    });
  });
  return output.trim();
}
