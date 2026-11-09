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

// Words that carry no identity for a deal: grammar, sales filler, and the
// date/exclusivity words that are compared as their own markers.
const STOPWORDS = new Set(`a an the of on in at for to up your you with and or plus per pp from by is are be as this that our its it
 ends end ending today ongoing exclusive tln ocapp select sailing voyage cruise vacation next get receive enjoy call agent speak
 detail booking book new upcoming now off save saving sale offer rate fare deal promo promotion code capacity controlled free
 will can all any more`.split(/\s+/));

// Words that say what kind of offer it is rather than which promotion it is.
const KIND_WORDS = new Set(`onboard credit discount bonus guest stateroom deposit reduced cabin suite person special extra
 package amenity departure trip tour resort stay`.split(/\s+/));

const NUMBER_WORDS = { one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10' };

/** Reduces deal text to the set of words that identify it, spelled one way. */
function tokenize(text) {
  const t = (text || '').toLowerCase()
    .replace(/\d{1,2}\/\d{1,2}(?:\/\w{2,5})?/g, ' ')
    .replace(/(\d),(\d)/g, '$1$2')
    .replace(/\bppgs?\b/g, ' prepaid gratuities ')
    .replace(/\bobcs?\b/g, ' onboard credit ')
    .replace(/\bshipboard\b|\bon\s+board\b/g, ' onboard ')
    .replace(/\b2nd\b/g, ' second ').replace(/\b3rd\b/g, ' third ').replace(/\b4th\b/g, ' fourth ')
    .replace(/\bmed\b/g, ' mediterranean ')
    .replace(/\bnrd\b|\bdep\b/g, ' deposit ')
    .replace(/\bsailors?\b/g, ' guest ')
    .replace(/\bdinners?\b/g, ' dining ');
  const tokens = new Set();
  for (let word of t.split(/[^a-z0-9]+/)) {
    if (!word) continue;
    word = NUMBER_WORDS[word] || word;
    if (STOPWORDS.has(word)) continue;
    if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) word = word.slice(0, -1);
    if (word.endsWith('ie')) word = `${word.slice(0, -2)}y`;
    if (!STOPWORDS.has(word)) tokens.add(word);
  }
  return tokens;
}

function figuresOf(text) {
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
  // "BOGO60" is HQ shorthand for 60% off the second guest.
  for (const m of text.matchAll(/\bbogo\s*(\d{2})\b/gi)) percents.add(parseInt(m[1], 10));
  return { dollars, percents };
}

/**
 * Reads the typed markers out of one deal's text: the kinds of offer, the
 * money and percent figures, nights, exclusivity, and its identifying words.
 * `head` is the part that states the offer itself (an incoming line without
 * its parenthetical asides, or a website title without its description); its
 * figures are the ones the other side must also carry.
 */
function extractMarkers(text, { exclusive = false, head } = {}) {
  const types = new Set();
  for (const [tag, re] of TYPE_PATTERNS) {
    if (re.test(text)) types.add(tag);
  }
  if (/\bbogo\s*\d{2}\b/i.test(text)) types.add('multi-guest');
  if (types.has("named-sale")) { types.delete("named-sale"); types.add("savings"); }
  const specific = [...types].filter(t => !GENERIC_TYPES.has(t));
  if (specific.length || types.has("savings")) { types.delete("perks"); types.delete("freebie"); }
  else if (types.has("perks")) types.delete("freebie");

  const { dollars, percents } = figuresOf(text);
  const headText = head ?? text.replace(/\([^)]*\)/g, ' ');
  const headFigures = figuresOf(headText);

  const nights = new Set();
  for (const m of text.matchAll(/\b(\d{1,2})\s*[-–]?\s*(?:nights?|nts?)\b/gi)) {
    nights.add(parseInt(m[1], 10));
  }

  const isExclusive = exclusive || types.has("covert") || /\[exclusive\]|\bexclusive\b|\btln\b/i.test(text);

  return {
    types, exclusive: isExclusive, dollars, percents, nights,
    headDollars: headFigures.dollars, headPercents: headFigures.percents,
    tokens: tokenize(text),
  };
}

// --- Marker comparison ---

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

const subset = (a, b) => [...a].every(v => b.has(v));
const shares = (a, b) => [...a].some(v => b.has(v));
const shortDate = (d) => `${d.getMonth() + 1}/${d.getDate()}`;

function fmtFigures(m) {
  const money = [...m.dollars].sort((a, b) => a - b).map(v => `$${v.toLocaleString('en-US')}`);
  const pct = [...m.percents].sort((a, b) => a - b).map(v => `${v}%`);
  return [...money, ...pct].join(', ') || '—';
}

/** How the two end dates relate, from the incoming deal's point of view. */
function compareDates(hq, web) {
  if (hq.end && web.expiryDate) return sameDay(hq.end, web.expiryDate) ? 'same' : 'different';
  if (hq.ongoing) return web.expiryDate ? 'different' : 'same';
  if (hq.end) return 'different';
  // The source gives no date at all ("Capacity Controlled"), so there is
  // nothing to hold against the website's date.
  return 'open';
}

function dateReason(hq, web) {
  if (hq.end && web.expiryDate) return `End date changed: the site says ${shortDate(web.expiryDate)}, this says ${shortDate(hq.end)}.`;
  if (hq.ongoing) return `This is ongoing, but the site entry ends ${shortDate(web.expiryDate)}.`;
  return `This ends ${shortDate(hq.end)}; the site entry has no end date.`;
}

/**
 * Decides what one website deal is to one incoming deal:
 *   on-site — the same offer is already live; nothing to do
 *   update  — probably the same promotion with a date or term changed
 *   none    — not the same deal
 * The decision uses typed markers only: kind of offer, the figures each side
 * leads with, the end date, exclusivity, and shared promotion words.
 */
function compareMarkers(hq, web, today = new Date()) {
  const H = hq.markers, W = web.markers;
  const hqSpecific = new Set([...H.types].filter(t => !GENERIC_TYPES.has(t)));
  const webSpecific = new Set([...W.types].filter(t => !GENERIC_TYPES.has(t)));
  const sameKind = shares(H.types, W.types);
  const sameSpecificKind = shares(hqSpecific, webSpecific);

  // Website copy adds detail and incoming lines add asides, so each side's
  // leading figures must appear somewhere on the other side.
  const hasFigures = H.headDollars.size + H.headPercents.size + W.headDollars.size + W.headPercents.size > 0;
  const nightsClash = H.nights.size > 0 && W.nights.size > 0 && !shares(H.nights, W.nights);
  const figuresAgree = subset(H.headDollars, W.dollars) && subset(H.headPercents, W.percents)
    && subset(W.headDollars, H.dollars) && subset(W.headPercents, H.percents) && !nightsClash;
  const sharedFigure = shares(H.dollars, W.dollars) || shares(H.percents, W.percents);

  const dates = compareDates(hq, web);
  const datesAgree = dates === 'same' || dates === 'open';
  const missingExclusive = H.exclusive && !W.exclusive;

  const shared = [...H.tokens].filter(t => W.tokens.has(t));
  const coverage = H.tokens.size ? shared.length / H.tokens.size : 0;
  const isName = (t) => !KIND_WORDS.has(t) && !/^\d+$/.test(t);
  const names = [...H.tokens].filter(isName);
  const sharedNames = shared.filter(isName);
  const sameName = sharedNames.length >= 2 || (sharedNames.length === 1 && names.length <= 2);

  let verdict = 'none';
  let reason = '';

  const bothCovert = H.types.has('covert') && W.types.has('covert') && !(H.headDollars.size + H.headPercents.size);
  if (bothCovert) {
    // One hidden-rates entry stands for every covert rate code a supplier
    // sends. Only a later, still-future end date is worth a look.
    const later = hq.end && web.expiryDate && !sameDay(hq.end, web.expiryDate) && hq.end > web.expiryDate && hq.end >= today;
    verdict = later ? 'update' : 'on-site';
    reason = later ? dateReason(hq, web) : 'Covered by the hidden-rates entry on the site.';
  } else if (sameKind || (!H.types.size && !W.types.size)) {
    const sameOffer = hasFigures ? (sameKind && figuresAgree) : coverage >= 0.6;
    if (sameOffer && datesAgree && !missingExclusive) {
      verdict = 'on-site';
      reason = hasFigures ? 'Same offer, same amounts, same end date.' : 'Same offer, same end date.';
    } else if (sameOffer && datesAgree) {
      verdict = 'update';
      reason = 'Same offer, but the site entry is not marked exclusive.';
    } else if (sameOffer && (!hasFigures || sharedFigure)) {
      verdict = 'update';
      reason = dateReason(hq, web);
    } else if (dates === 'same' && sameSpecificKind && hasFigures) {
      verdict = 'update';
      reason = `Same kind of offer and end date, different amounts: the site says ${fmtFigures(W)}, this says ${fmtFigures(H)}.`;
    } else if (sameKind && sameName) {
      verdict = 'update';
      reason = `Shares "${sharedNames.slice(0, 3).join(' ')}" with a site entry, but the terms differ.`;
    }
  }

  let score = 0;
  if (verdict !== 'none') {
    score = verdict === 'on-site' ? 1000 : 200;
    if (verdict === 'update' && figuresAgree && sharedFigure) score += 100;
    if (dates === 'same') score += 60;
    if (H.exclusive === W.exclusive) score += 30;
    score += Math.round(coverage * 100) + sharedNames.length * 10;
  }

  const checks = [
    { key: 'type', label: 'Offer', status: sameKind ? 'same' : 'different', hq: describeTypes(H.types), web: describeTypes(W.types) },
    { key: 'figures', label: 'Amounts', status: !hasFigures ? 'n/a' : figuresAgree ? 'same' : 'different', hq: fmtFigures(H), web: fmtFigures(W) },
    { key: 'expiry', label: 'Ends', status: datesAgree ? 'same' : 'different', hq: hq.ongoing ? 'Ongoing' : hq.end ? dateFmt.format(hq.end) : 'No date given', web: web.expiryDate ? dateFmt.format(web.expiryDate) : 'No end date' },
    { key: 'exclusive', label: 'Exclusive', status: H.exclusive === W.exclusive ? 'same' : 'different', hq: H.exclusive ? 'Yes' : 'No', web: W.exclusive ? 'Yes' : 'No' },
  ];

  return {
    score,
    verdict,
    reason,
    identical: verdict === 'on-site',
    covert: bothCovert,
    checks,
    differences: checks.filter(c => c.status === 'different').map(c => c.key),
  };
}

function buildEmptyMeta(overrides = {}) {
  return {
    score: 0,
    verdict: 'new',
    reason: overrides.noWebDeals ? 'This supplier has nothing on the site yet.' : 'Nothing like it on the site for this supplier.',
    identical: false,
    covert: false,
    checks: [],
    differences: [],
    ...overrides,
  };
}

// Saved decisions belong to the candidate assignments produced by this version.
export const MATCHER_VERSION = 4;

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


/**
 * Pairs one supplier's incoming deals with its website deals. Covert rates
 * are settled first and may share a single hidden-rates entry; every other
 * incoming deal gets at most one website deal of its own, chosen so that the
 * most deals overall are recognized as already live.
 */
function optimalMatch(hqGroup, webGroup, today) {
  const out = new Map();
  const rest = [];
  for (const hq of hqGroup) {
    let best = null;
    for (const web of webGroup) {
      const meta = compareMarkers(hq, web, today);
      if (meta.covert && (!best || meta.score > best.meta.score)) best = { web, meta };
    }
    if (best) out.set(hq, best);
    else rest.push(hq);
  }

  const n = rest.length, m = webGroup.length;
  const matrix = rest.map(hq => webGroup.map(web => compareMarkers(hq, web, today)));
  let pairs;
  if (n <= 20 && m <= 20) {
    pairs = assignCandidateMatrix(matrix, n, m);
  } else {
    const cells = [];
    matrix.forEach((row, i) => row.forEach((meta, j) => { if (meta.score > 0) cells.push({ i, j, score: meta.score }); }));
    cells.sort((a, b) => b.score - a.score);
    const takenHQ = new Set(), takenWeb = new Set();
    pairs = rest.map((_, i) => [i, -1]);
    for (const c of cells) {
      if (takenHQ.has(c.i) || takenWeb.has(c.j)) continue;
      takenHQ.add(c.i); takenWeb.add(c.j);
      pairs[c.i] = [c.i, c.j];
    }
  }
  for (const [i, j] of pairs) {
    out.set(rest[i], j !== -1 ? { web: webGroup[j], meta: matrix[i][j] } : { web: null, meta: buildEmptyMeta() });
  }
  return hqGroup.map(hq => ({ hq, ...out.get(hq) }));
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
    const markers = extractMarkers(text, { head: row.title || '' });
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
export function runFullMatch(hqDeals, websiteDeals, { filterSupplier = '', today = new Date() } = {}) {
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
      allResults.push(...optimalMatch(hqGroup, webGroup, today));
    }
  }
  return allResults;
}

/**
 * Partitions comparison results into two outcomes: `identical` rows (already
 * live on the site, set aside) and `work` rows (everything to add or update:
 * new deals, extensions, changed terms, or a row the operator pulled back).
 * The optional ending-today rule is terminal and never reaches Publish.
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
