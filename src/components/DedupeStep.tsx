import React, { useMemo, useCallback, useEffect, useRef, useState } from 'react';
import {
  parseHQ, resetIds, ingestWebsiteJSON, runFullMatch, compareMarkers,
  categorizeDedupeResults, exportUnmatched,
  MATCHER_VERSION,
} from '../logic/dedupe.js';
import { compareWithJev, applyJevAnswers, applyDecisions, reconsiderWithJev, needsReview, pendingJevDeals } from '../logic/jev.js';
import { validateWebsiteExport } from '../logic/dealCoreClient';

function parseWebsiteRows(text) {
  const data = JSON.parse(text);
  return Array.isArray(data) ? data : data.entries || data.data || [];
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// One Jev request through the server-side proxy; the key never reaches here.
async function callJev(body) {
  const response = await fetch('/api/jev', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(90_000) });
  if (!response.ok) throw Object.assign(new Error(`Jev ${response.status}`), { status: response.status });
  return (await response.json()).answers;
}

const CALL = {
  update: 'Same deal — update it',
  'on-site': 'Already live — nothing to do',
  new: 'New deal — not on the site',
};

/**
 * Compares the tagged batch with the website export using Jev (DEC-07) and
 * lands on one sentence and one button. Jev's calls can be reviewed one card
 * at a time, least sure first; the operator's call always wins. The whole
 * step accepts a dropped website export, and comparison starts by itself.
 */
export default function DedupeStep({ session, onSessionChange, onComplete, showToast }) {
  const fileRef = useRef(null);
  const jevJob = useRef(null);
  const [importError, setImportError] = useState('');
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState(null);
  const [reviewAt, setReviewAt] = useState(-1);
  const decisions = session.decisions || {};
  const { hqText, websiteRows, lastRun } = session;

  const updateSession = useCallback((patch) => {
    onSessionChange((prev) => (
      typeof patch === 'function' ? patch(prev) : { ...prev, ...patch }
    ));
  }, [onSessionChange]);

  const hqDeals = useMemo(() => {
    if (!hqText.trim()) return [];
    resetIds();
    return parseHQ(hqText);
  }, [hqText]);

  // Changing either input clears lastRun, so a run of this version is current.
  const current = !!lastRun && lastRun.matcherVersion === MATCHER_VERSION && lastRun.hqText === hqText;
  const canCompare = hqDeals.length > 0 && websiteRows.length > 0;

  const frozen = useMemo(() => {
    if (!current) return null;
    resetIds();
    return { hq: parseHQ(lastRun.hqText), web: ingestWebsiteJSON(lastRun.websiteRows) };
  }, [current, lastRun]);

  // Start a comparison as soon as both inputs exist; ask Jev once per run.
  useEffect(() => {
    if (!canCompare || current) return;
    updateSession({ lastRun: { matcherVersion: MATCHER_VERSION, hqText, websiteRows, jev: null }, decisions: {} });
    setReviewAt(-1);
  }, [canCompare, current, hqText, websiteRows, updateSession]);

  useEffect(() => {
    if (!frozen) return;
    let job = jevJob.current;
    const sameRun = job && (job.run === lastRun || !!lastRun.jev) && job.hqText === lastRun.hqText && job.websiteRows === lastRun.websiteRows && job.matcherVersion === lastRun.matcherVersion;
    if (sameRun && job.settled) return;
    if (!sameRun && lastRun.jev && !pendingJevDeals(frozen.hq, frozen.web, lastRun.jev).length) return;
    let cancelled = false;
    setProgress({ done: 0, total: frozen.hq.length });
    if (!sameRun) {
      job = { run: lastRun, hqText: lastRun.hqText, websiteRows: lastRun.websiteRows, matcherVersion: lastRun.matcherVersion, settled: false, onProgress: null, promise: null };
      jevJob.current = job;
      job.promise = compareWithJev(frozen.hq, frozen.web, callJev, {
        cache: lastRun.jev || {},
        onProgress: (done, total) => job.onProgress?.(done, total),
      }).then(result => { job.settled = true; return result; });
    }
    job.onProgress = (done, total) => { if (!cancelled) setProgress({ done, total }); };
    job.promise.then(({ answers }) => {
      if (cancelled) return;
      setProgress(null);
      updateSession((prev) => (prev.lastRun === lastRun ? { ...prev, lastRun: { ...lastRun, jev: answers } } : prev));
    });
    return () => { cancelled = true; };
  }, [frozen, lastRun, updateSession]);

  const results = useMemo(() => {
    if (!frozen || !lastRun.jev) return null;
    const jevResults = applyJevAnswers(runFullMatch(frozen.hq, frozen.web), frozen.web, lastRun.jev);
    return applyDecisions(jevResults, decisions, frozen.web);
  }, [frozen, lastRun, decisions]);

  const categorized = useMemo(() => (results ? categorizeDedupeResults(results) : null), [results]);
  const requestedJev = results?.filter(r => r.meta?.candidates?.length && !r.meta?.jevSkipped) || [];
  const jevDown = requestedJev.length > 0 && requestedJev.every(r => r.meta?.jevError);

  // Every call Jev made against a real website deal, split into the few it is
  // unsure about (cards) and the confident rest (optional skim list).
  const { unsure, sure } = useMemo(() => {
    if (!categorized) return { unsure: [], sure: [] };
    const calls = [...categorized.update, ...categorized.onSite, ...categorized.added]
      .filter(r => r.meta?.candidates?.length && !r.meta?.jevSkipped)
      .sort((a, b) => (a.meta?.jevError ? -1 : a.meta?.confidence ?? 0) - (b.meta?.jevError ? -1 : b.meta?.confidence ?? 0) || a.hq.id - b.hq.id);
    // A row the operator already decided stays where it was first sorted.
    const isUnsure = (r) => (r.meta?.reviewed ? !!decisions[r.hq.id]?.wasUnsure : needsReview(r));
    return { unsure: calls.filter(isUnsure), sure: calls.filter(r => !isUnsure(r)) };
  }, [categorized, decisions]);
  const [skimming, setSkimming] = useState(false);
  // Freeze the order when review starts so cards don't jump as calls change.
  const [reviewOrder, setReviewOrder] = useState([]);
  const startReview = (rows = unsure) => {
    const pending = rows.filter(r => !decisions[r.hq.id]);
    setReviewOrder((pending.length ? pending : rows).map(r => r.hq.id));
    setReviewAt(0);
  };

  const decide = useCallback((row, verdict, webIndex) => {
    const wasUnsure = row.meta?.reviewed ? !!decisions[row.hq.id]?.wasUnsure : needsReview(row);
    updateSession({ decisions: { ...decisions, [row.hq.id]: { verdict, web: verdict === 'new' ? null : webIndex, wasUnsure } } });
    setReviewAt((at) => at + 1);
  }, [decisions, updateSession]);

  const loadExport = useCallback(async (file) => {
    if (!file) return;
    try {
      const rows = parseWebsiteRows(await file.text());
      const validation = await validateWebsiteExport(rows);
      if ('error' in validation) {
        setImportError(validation.error.message);
        return;
      }
      setImportError('');
      updateSession({ websiteRows: validation.data.rows, websiteFileName: file.name, lastRun: null, decisions: {} });
    } catch (error) {
      setImportError(`That file isn't a website export (${error instanceof Error ? error.message : String(error)}).`);
    }
  }, [updateSession]);

  const dropProps = {
    onDragOver: (event) => { event.preventDefault(); setDragging(true); },
    onDragLeave: () => setDragging(false),
    onDrop: (event) => { event.preventDefault(); setDragging(false); loadExport(event.dataTransfer.files?.[0]); },
  };
  const fileInput = <input ref={fileRef} type="file" accept=".json" className="visually-hidden" onChange={(event) => { loadExport(event.target.files?.[0]); event.target.value = ''; }} />;

  if (!hqDeals.length) {
    return <div className="calm"><p className="calm-head">Nothing to compare yet.</p><p className="calm-sub">Tag this week's deals first.</p></div>;
  }

  if (!websiteRows.length) {
    return <div className={`calm calm-drop ${dragging ? 'is-dragging' : ''}`} {...dropProps} onClick={() => fileRef.current?.click()} role="button" tabIndex={0}>
      <p className="calm-head">Drop this week's website export here.</p>
      <p className="calm-sub">{importError || 'Or click anywhere to choose it.'}</p>
      {fileInput}
    </div>;
  }

  if (!categorized) {
    const pct = progress?.total ? Math.round((progress.done / progress.total) * 100) : 0;
    return <div className="calm">
      <p className="calm-head">Jev is comparing your deals…</p>
      <div className="calm-bar"><span style={{ width: `${pct}%` }} /></div>
      <p className="calm-sub">{progress ? `${progress.done} of ${progress.total}` : ''}</p>
    </div>;
  }

  const byId = new Map<number, any>((results || []).map((r: any) => [r.hq.id, r]));
  const reviewRow = reviewAt >= 0 && reviewAt < reviewOrder.length ? byId.get(reviewOrder[reviewAt]) : null;
  if (reviewRow) {
    // Re-ask Jev with the operator's doubt; the new answer replaces the old
    // one and any decision on this deal is cleared so the card shows it.
    const reconsider = async (row) => {
      try {
        const answers = await reconsiderWithJev(row.hq, frozen.web, row.web, callJev);
        updateSession((prev) => {
          const nextDecisions = { ...(prev.decisions || {}) };
          delete nextDecisions[row.hq.id];
          return { ...prev, decisions: nextDecisions, lastRun: { ...prev.lastRun, jev: { ...prev.lastRun.jev, [row.hq.id]: answers } } };
        });
      } catch {
        showToast('Jev could not be reached', 'error');
      }
    };
    return <ReviewCard
      key={`${reviewRow.hq.id}-${lastRun.jev?.[reviewRow.hq.id]?.reconsidered ? 'again' : 'first'}-${reviewRow.web ? frozen.web.indexOf(reviewRow.web) : 'none'}`}
      r={reviewRow}
      websiteDeals={frozen.web}
      position={reviewAt + 1}
      total={reviewOrder.length}
      onDecide={decide}
      onBack={() => setReviewAt((at) => Math.max(0, at - 1))}
      onClose={() => setReviewAt(-1)}
      onReconsider={reconsider}
    />;
  }

  if (skimming) {
    return <SkimList
      rows={sure}
      onOpen={(row) => { setSkimming(false); startReview([row]); }}
      onClose={() => setSkimming(false)}
    />;
  }

  const toPublish = [...categorized.update, ...categorized.added];
  const leftToReview = unsure.filter(r => !decisions[r.hq.id]).length;
  const sendToPublish = () => {
    if (!toPublish.length) return;
    // Updates keep the website entry's URL in Publish; new deals get a slug.
    onComplete(exportUnmatched(toPublish.map(row => row.hq)), [
      ...categorized.update.map(row => ({ vendor: row.hq.vendor, text: row.hq.text, action: 'update', websiteTitle: row.web?.raw?.title || '' })),
      ...categorized.added.map(row => ({ vendor: row.hq.vendor, text: row.hq.text, action: 'new', websiteTitle: '' })),
    ]);
  };

  return (
    <div className={`calm ${dragging ? 'is-dragging' : ''}`} {...dropProps}>
      <p className="calm-head">{toPublish.length ? `${plural(toPublish.length, 'deal')} ready for Publish.` : 'Everything is already on the site.'}</p>
      <div className="tally">
        <Tally kind="update" n={categorized.update.length} label={categorized.update.length === 1 ? 'update' : 'updates'} />
        <Tally kind="new" n={categorized.added.length} label="new" />
        <Tally kind="live" n={categorized.onSite.length} label="already live" />
        {!!categorized.excluded.length && <Tally kind="out" n={categorized.excluded.length} label="end today, left out" />}
      </div>
      {jevDown && <p className="calm-sub calm-error">Jev isn't connected, so these are the built-in rules' calls.</p>}
      <div className="calm-actions">
        {leftToReview > 0 && <button className="calm-go" onClick={() => startReview()}>Check {leftToReview === 1 ? 'the 1 deal' : `the ${leftToReview} deals`} Jev isn't sure about →</button>}
        {!!toPublish.length && <button className={leftToReview > 0 ? 'calm-second' : 'calm-go'} onClick={sendToPublish}>Continue to Publish →</button>}
      </div>
      <p className="calm-note">
        {leftToReview === 0 && unsure.length > 0 ? 'Every unsure call is checked. ' : ''}
        {sure.length > 0 && <>Jev is sure about {sure.length} more. <button onClick={() => setSkimming(true)}>skim them</button></>}
      </p>
      {importError && <p className="calm-sub calm-error">{importError}</p>}
      <p className="calm-foot">{session.websiteFileName || 'Website export'} · <button onClick={() => fileRef.current?.click()}>replace</button>{fileInput}</p>
    </div>
  );
}

const GLYPH = { same: '✓', different: '✗', partial: '~', unknown: '?', 'n/a': '–', open: '–' };

// The typed facts side by side. A website deal with no end date is neutral:
// it says nothing about expiry.
function FactsTable({ hq, web }) {
  const checks = web ? compareMarkers(hq, web).checks : null;
  if (!checks) return null;
  return <table className="facts">
    <tbody>
      {checks.map((c) => {
        // Ongoing and no end date are the same thing; a dated deal vs no end date is neutral.
        const status = c.key === 'expiry' && !web.expiryDate ? (hq.ongoing || !hq.end ? 'same' : 'open') : c.status;
        return <tr key={c.key} className={`fact-${status === 'n/a' ? 'na' : status}`}>
          <th><span className="fact-glyph">{GLYPH[status] || '?'}</span>{c.label}</th>
          <td>{c.hq}</td>
          <td>{c.key === 'expiry' && !web.expiryDate ? 'No end date' : c.web}</td>
        </tr>;
      })}
    </tbody>
  </table>;
}

/**
 * One of Jev's calls: this week's deal beside the website deal Jev picked,
 * the typed facts compared, and Jev's verdict. → keeps Jev's call; U / L set
 * update or live against the shown deal; N means "not this one" and steps to
 * Jev's next most likely website deal, landing on new when none are left;
 * R asks Jev to reconsider.
 */
function ReviewCard({ r, websiteDeals, position, total, onDecide, onBack, onClose, onReconsider }) {
  const ranked = r.meta?.ranked?.length ? r.meta.ranked : (r.meta?.candidates || []).map(web => ({ web, p: null }));
  const jevVerdict = r.web ? r.meta?.verdict : 'new';
  // Even when Jev says new, start on its closest website deal so it can be compared.
  const start = r.web ? Math.max(0, ranked.findIndex(x => x.web === r.web)) : 0;
  const [at, setAt] = useState(start);
  const [asking, setAsking] = useState(false);
  const shown = at < ranked.length ? ranked[at] : null;
  const web = shown?.web || null;
  const index = web ? websiteDeals.indexOf(web) : null;
  const sure = r.meta?.jevError ? null : Math.round((r.meta?.confidence ?? 0) * 100);
  const isJevPick = !!web && web === r.web;

  // Looking at a different website deal than the one Jev picked.
  const onAlt = !!r.web && at !== start;
  const jevIndex = r.web ? websiteDeals.indexOf(r.web) : null;
  // "It is this deal": live when every stated term agrees, otherwise update.
  const sameAs = useCallback((w, i) => onDecide(r, compareMarkers(r.hq, w).differences.some(k => ['dollars', 'percents', 'nights', 'expiry'].includes(k)) ? 'update' : 'on-site', i), [onDecide, r]);
  const correct = useCallback(() => {
    if (onAlt && web) sameAs(web, index);
    else onDecide(r, jevVerdict, jevIndex);
  }, [onAlt, web, index, sameAs, onDecide, r, jevVerdict, jevIndex]);
  // Wrong on a match: try Jev's next plausible website deal, else it is new.
  // Wrong on "new": it is the closest website deal shown.
  const wrong = useCallback(() => {
    if (!r.web) {
      if (web) sameAs(web, index); else onDecide(r, 'new', null);
      return;
    }
    const next = ranked.findIndex((x, i) => i > at && i !== start && (x.p == null || x.p >= 0.1));
    if (next >= 0) setAt(next); else onDecide(r, 'new', null);
  }, [r, web, index, sameAs, onDecide, ranked, at, start]);
  const reconsider = useCallback(async () => {
    if (asking) return;
    setAsking(true);
    try { await onReconsider(r); } finally { setAsking(false); }
  }, [asking, onReconsider, r]);

  useEffect(() => {
    const onKey = (event) => {
      if (event.target instanceof HTMLElement && ['INPUT', 'TEXTAREA'].includes(event.target.tagName)) return;
      const key = event.key.toLowerCase();
      if (key === 'arrowright' || key === 'enter' || key === 'c') correct();
      else if (key === 'arrowleft') onBack();
      else if (key === 'escape') onClose();
      else if (key === 'u' && web) onDecide(r, 'update', index);
      else if (key === 'w' || key === 'n') wrong();
      else if (key === 'r') reconsider();
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [web, index, onDecide, r, onBack, onClose, correct, wrong, reconsider]);

  const others = ranked.length - 1;
  return <div className="review">
    <div className="review-top">
      <span>{position} of {total}</span>
      <span className="review-progress" aria-hidden="true"><span style={{ width: `${Math.round(((position - 1) / Math.max(1, total)) * 100)}%` }} /></span>
      <button onClick={onClose}>done for now</button>
    </div>
    <p className="review-supplier">{r.hq.vendor}</p>
    <div className="review-pair">
      <div className="review-side">
        <span className="review-label">This week</span>
        <p className="review-text">{r.hq.text}</p>
      </div>
      <div className="review-side is-site">
        <span className="review-label">
          {web ? `${isJevPick ? 'On the website — Jev\'s pick' : jevVerdict === 'new' && at === 0 ? 'Closest on the website' : 'On the website'}${shown.p != null ? ` · Jev ${Math.round(shown.p * 100)}% match` : ''}` : 'On the website'}
        </span>
        {web ? <>
          <p className="review-text">{web.raw?.title}</p>
          {web.raw?.shopListing && <p className="review-desc">{web.raw.shopListing}</p>}
        </> : <p className="review-text review-none">{ranked.length ? `None of ${r.hq.vendor}'s ${ranked.length} website ${ranked.length === 1 ? 'deal matches' : 'deals match'}.` : `${r.hq.vendor} has nothing comparable on the site.`}</p>}
      </div>
    </div>
    <FactsTable hq={r.hq} web={web} />
    <p className="review-call">
      {onAlt
        ? <>Is it this one instead?</>
        : <>Jev: <strong>{CALL[jevVerdict]}</strong>{sure !== null ? ` · ${sure}% sure` : ' · Jev unavailable, built-in rules'}{r.meta?.reconsidered ? ' · reconsidered' : ''}</>}
    </p>
    <div className="review-buttons">
      <button className="is-main" onClick={correct}>{onAlt ? 'Yes, this one' : 'Correct'} <kbd>→</kbd></button>
      <button className="is-update" disabled={!web} onClick={() => onDecide(r, 'update', index)}>Same deal, update <kbd>U</kbd></button>
      <button className="is-wrong" onClick={wrong}>{onAlt ? 'No' : 'Wrong'} <kbd>W</kbd></button>
    </div>
    <p className="review-others">
      <button onClick={reconsider} disabled={asking}>{asking ? 'asking Jev…' : 'ask Jev again'}</button>
      {others > 0 && <> · other {r.hq.vendor} deals: {ranked.map((x, i) => i === at ? null : <button key={i} onClick={() => setAt(i)}>{x.web.raw?.title}{x.p != null ? ` (${Math.round(x.p * 100)}%)` : ''}</button>)}</>}
      {others === 0 && web && <> · no other {r.hq.vendor} deals on the site</>}
    </p>
  </div>;
}

const SKIM_CALL = { update: 'update', 'on-site': 'already live', new: 'new' };

/**
 * Optional: Jev's confident calls as one skimmable list, this week's deal
 * beside the website deal it matched. Clicking a row opens it as a card.
 */
function SkimList({ rows, onOpen, onClose }) {
  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return <div className="skim">
    <div className="review-top">
      <span>Jev is sure about these {rows.length}. Click any that look wrong.</span>
      <button onClick={onClose}>back</button>
    </div>
    <div className="skim-list">
      {rows.map(r => <button key={r.hq.id} className="skim-row" onClick={() => onOpen(r)}>
        <span className="skim-who">{r.hq.vendor}</span>
        <span className="skim-in">{r.hq.text}</span>
        <span className="skim-arrow">→</span>
        <span className={`skim-site ${r.web ? '' : 'is-none'}`}>{r.web ? r.web.raw?.title : 'not on the site'}</span>
        <span className={`skim-call is-${r.web ? r.meta?.verdict : 'new'}`}>{SKIM_CALL[r.web ? r.meta?.verdict : 'new']}</span>
      </button>)}
    </div>
  </div>;
}

// Counts up from zero when the summary appears.
function useCountUp(target, ms = 700) {
  const [value, setValue] = useState(0);
  useEffect(() => {
    let frame = 0;
    const start = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - start) / ms);
      setValue(Math.round(target * (1 - (1 - t) ** 3)));
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, ms]);
  return value;
}

function Tally({ kind, n, label }) {
  const shown = useCountUp(n);
  return <div className={`tally-item tally-${kind}`}>
    <span className="tally-num" aria-hidden="true">{shown}</span>
    <span className="tally-label"><span className="visually-hidden">{n} </span>{label}</span>
  </div>;
}
