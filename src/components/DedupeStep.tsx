import React, { useMemo, useCallback, useRef, useState } from 'react';
import {
  parseHQ, resetIds, ingestWebsiteJSON, runFullMatch,
  categorizeDedupeResults, exportUnmatched, sameDay, dateFmt,
  MATCHER_VERSION,
} from '../logic/dedupe.js';
import { buildReviewQueue } from '../logic/review.js';
import { validateWebsiteExport } from '../logic/dealCoreClient';

function parseWebsiteRows(text) {
  const data = JSON.parse(text);
  return Array.isArray(data) ? data : data.entries || data.data || [];
}

/**
 * Orchestrates website-export validation, supplier-scoped marker matching, and
 * the operator's two-way sort: rows identical to the website are pre-checked
 * for bulk confirmation, everything else is the work list handed to
 * Copywriting. Matcher inputs are frozen into `lastRun`.
 */
export default function DedupeStep({ session, onSessionChange, onComplete, showToast }) {
  const fileRef = useRef(null);
  const [importError, setImportError] = useState('');
  const [search, setSearch] = useState('');
  const [lastDecision, setLastDecision] = useState(null);
  const decisions = session.decisions || {};
  const activeView = ['work', 'identical'].includes(session.viewFilter) ? session.viewFilter : 'work';

  const {
    hqText,
    websiteRows,
    lastRun,
    supplierFilter,
    restrictToday,
  } = session;

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

  const websiteDeals = useMemo(() => ingestWebsiteJSON(websiteRows), [websiteRows]);
  const webSuppliers = useMemo(
    () => [...new Set(websiteDeals.map((deal) => deal.supplier))].sort(),
    [websiteDeals],
  );

  const results = useMemo(() => {
    if (!lastRun) return null;
    if (lastRun.matcherVersion !== MATCHER_VERSION) return null;
    if (!lastRun.hqText.trim() || !lastRun.websiteRows.length) return null;
    resetIds();
    const lastRunDeals = parseHQ(lastRun.hqText);
    const lastRunWebsiteDeals = ingestWebsiteJSON(lastRun.websiteRows);
    return runFullMatch(lastRunDeals, lastRunWebsiteDeals, {
      filterSupplier: lastRun.supplierFilter,
    });
  }, [lastRun]);

  const categorized = useMemo(() => {
    if (!results) return null;
    return categorizeDedupeResults(results, {
      excludeEndingToday: restrictToday,
    });
  }, [results, restrictToday]);

  const queue = useMemo(() => buildReviewQueue(categorized, decisions), [categorized, decisions]);
  const filtered =(rows) => rows.filter((row) => `${row.hq.vendor} ${row.hq.text} ${row.web?.raw?.title || ''}`.toLowerCase().includes(search.toLowerCase()));
  const decide = (id, value) => {
    setLastDecision({ previous: { ...decisions } });
    const next = { ...decisions };
    if (value === undefined) delete next[id]; else next[id] = value;
    updateSession({ decisions: next });
  };
  const undo = () => {
    if (!lastDecision) return;
    updateSession({ decisions: lastDecision.previous });
    setLastDecision(null);
  };

  const dateWarnings = useMemo(() => hqDeals.filter((deal) => deal.dateWarning), [hqDeals]);

  const handleFileLoad = useCallback(async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const rows = parseWebsiteRows(text);
      const validation = await validateWebsiteExport(rows);

      if ('error' in validation) {
        setImportError(validation.error.message);
        updateSession({ websiteRows: [], lastRun: null, decisions: {} });
        showToast('Website export not recognized', 'error');
        return;
      }

      setImportError('');
      updateSession({ websiteRows: validation.data.rows, websiteFileName: file.name, lastRun: null, decisions: {} });
      showToast(
        `${validation.data.recognizedCount} website deals loaded`,
        'success',
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setImportError(`Could not read this JSON file: ${message}`);
      updateSession({ websiteRows: [], lastRun: null, decisions: {} });
      showToast('Failed to parse website JSON', 'error');
    } finally {
      event.target.value = '';
    }
  }, [showToast, updateSession]);

  const runMatcher = useCallback(() => {
    if (!hqDeals.length) {
      showToast('Paste HQ text first', 'error');
      return;
    }
    if (!websiteRows.length) {
      showToast('Load website JSON first', 'error');
      return;
    }

    updateSession({
      lastRun: {
        matcherVersion: MATCHER_VERSION,
        hqText,
        websiteRows,
        supplierFilter,
      },
      decisions: {},
      viewFilter: 'work',
    });
    setLastDecision(null);
  }, [hqDeals.length, hqText, showToast, supplierFilter, updateSession, websiteRows]);


  const handleExportWork = async () => {
    if (!queue.work.length) return;
    try {
      await navigator.clipboard.writeText(exportUnmatched(queue.work.map(row => row.hq)));
      showToast('Work list copied', 'success');
    } catch { showToast('Clipboard unavailable. Please try again.', 'error'); }
  };
  const handleSendToCopy = () => {
    if (!queue.work.length) return;
    // A same-kind website sibling means the operator will edit that entry
    // rather than create a new one, so Copywriting keeps its URL.
    onComplete(exportUnmatched(queue.work.map(row => row.hq)), queue.work.map(row => ({
      vendor: row.hq.vendor,
      text: row.hq.text,
      action: row.web && ['same', 'partial'].includes(row.meta?.typeStatus) && !row.meta?.operatorRejectedMatch ? 'update' : 'new',
      websiteTitle: row.web?.raw?.title || '',
    })));
  };

  const canCompare = hqDeals.length > 0 && websiteDeals.length > 0;
  const sourceVendorCount = new Set(hqDeals.map((deal) => deal.vendor)).size;

  return (
    <div className="dedupe-step dedupe-workflow">
      <section className="dedupe-setup">
        <div className="dedupe-section-heading">
          <div><span className="workspace-eyebrow">Prepare the comparison</span><h3>Find what needs your attention.</h3></div>
          {lastRun && <span className="status-chip status-complete">Comparison ready</span>}
        </div>
        <div className="dedupe-setup-grid">
          <article className={`setup-card ${hqDeals.length ? 'is-ready' : ''}`}>
            <span className="setup-index">1</span>
            <div className="setup-card-copy"><span className="setup-label">New deal batch</span><strong>{hqDeals.length ? `${hqDeals.length} deals from ${sourceVendorCount} suppliers` : 'No deals loaded'}</strong><span>{hqDeals.length ? 'Carried forward from Tag' : 'Complete the Tag step first'}</span></div>
            <span className="setup-check">{hqDeals.length ? '✓' : ''}</span>
          </article>
          <article className={`setup-card ${websiteDeals.length ? 'is-ready' : ''}`}>
            <span className="setup-index">2</span>
            <div className="setup-card-copy"><span className="setup-label">Current website</span><strong>{websiteDeals.length ? `${websiteDeals.length} live deals loaded` : 'Load the website export'}</strong><button className="setup-link" onClick={() => fileRef.current?.click()}>{websiteDeals.length ? `Replace ${session.websiteFileName || 'JSON export'}` : 'Choose true_entries.json'}</button></div>
            <span className="setup-check">{websiteDeals.length ? '✓' : ''}</span>
            <input ref={fileRef} type="file" accept=".json" className="visually-hidden" onChange={handleFileLoad} />
          </article>
          <article className={`setup-card setup-action ${canCompare ? 'is-ready' : ''}`}>
            <span className="setup-index">3</span>
            <div className="setup-card-copy"><span className="setup-label">Compare</span><strong>{canCompare ? 'Find what is already live' : 'Waiting for both inputs'}</strong><span>Review matches, keep new and changed deals.</span></div>
            <button className="btn btn-accent compare-button" onClick={runMatcher} disabled={!canCompare}>{lastRun ? 'Compare again' : 'Compare deals'}</button>
          </article>
        </div>
        {importError && <div className="gate-warning gate-warning-error import-blocker" role="alert"><strong>That website export could not be used.</strong><div>{importError}</div></div>}
        <details className="dedupe-disclosure">
          <div className="advanced-grid">
            <label className="advanced-source"><span>Tagged source</span><textarea value={hqText} onChange={(event) => updateSession({ hqText: event.target.value, lastRun: null, decisions: {} })} spellCheck={false} /></label>
            <div className="advanced-controls">
              <label className="mini-label">Supplier <select value={supplierFilter} onChange={(event) => updateSession({ supplierFilter: event.target.value, lastRun: null, decisions: {} })}><option value="">All suppliers</option>{webSuppliers.map((supplier) => <option key={String(supplier)}>{String(supplier)}</option>)}</select></label>
              <button className={`btn ${restrictToday ? 'btn-danger' : ''}`} onClick={() => updateSession({ restrictToday: !restrictToday })}>Exclude ending today: {restrictToday ? 'On' : 'Off'}</button>
            </div>
          </div>
        </details>
      </section>

      {dateWarnings.length > 0 && (
        <details className="dedupe-disclosure warning-disclosure">
          <summary>{dateWarnings.length} date {dateWarnings.length === 1 ? 'warning' : 'warnings'} need review</summary>
          {dateWarnings.map((deal, index) => <div key={index} className="date-warning"><strong>{deal.vendor}:</strong> {deal.dateWarning}<div className="mini">{deal.text}</div></div>)}
        </details>
      )}

      {categorized ? (
        <section className="dedupe-results">
          <div className="results-hero">
            <div><span className="workspace-eyebrow">Your work list</span><h3>{queue.work.length} to work on · {queue.skipped.length} already on the site</h3><p>{queue.pending.length ? `${queue.pending.length} look identical to the website. Confirm them to set them aside.` : 'Everything identical has been set aside.'}</p></div>
            <div className="results-actions">
              <button className="btn" disabled={!queue.work.length || !!queue.pending.length} onClick={handleExportWork}>Copy work list</button>
              <button className="btn btn-forward" disabled={!queue.work.length || !!queue.pending.length} onClick={handleSendToCopy}>{queue.pending.length ? `Confirm ${queue.pending.length} identical first` : `Send ${queue.work.length} to Publish →`}</button>
            </div>
          </div>
          <div className="review-toolbar">
            <div className="review-tabs" aria-label="Comparison views">
              <button className={`btn ${activeView === 'work' ? 'btn-accent' : ''}`} onClick={() => updateSession({ viewFilter: 'work' })}>Work list · {queue.work.length}</button>
              <button className={`btn ${activeView === 'identical' ? 'btn-accent' : ''}`} onClick={() => updateSession({ viewFilter: 'identical' })}>Already on site · {queue.pending.length + queue.skipped.length}{queue.pending.length ? ` (${queue.pending.length} to confirm)` : ''}</button>
            </div>
            <label className="review-search">Find a deal<input value={search} onChange={e => setSearch(e.target.value)} placeholder="Supplier or offer…" /></label>
            <button className="btn" disabled={!lastDecision} onClick={undo}>Undo last decision</button>
          </div>
          {activeView === 'identical' && queue.pending.length > 0 && <div className="review-finish"><span>{queue.pending.length} pre-checked as identical: same type, exclusivity, amounts, and expiry. Glance through, pull any into the work list, then confirm the rest.</span><button className="btn btn-success" onClick={() => {
            setLastDecision({ previous: { ...decisions } });
            updateSession({ decisions: { ...decisions, ...Object.fromEntries(queue.pending.map(row => [row.hq.id, 'skip'])) } });
          }}>Confirm all {queue.pending.length} as already on site</button></div>}
          <div className="compact-card-list">
            {activeView === 'work' && filtered(queue.work).map(row => <MatchCard key={row.hq.id} r={row} today={categorized.today} onDecision={decide} state="work" />)}
            {activeView === 'identical' && filtered(queue.pending).map(row => <MatchCard key={row.hq.id} r={row} today={categorized.today} onDecision={decide} state="pending" />)}
            {activeView === 'identical' && filtered(queue.skipped).map(row => <MatchCard key={row.hq.id} r={row} today={categorized.today} onDecision={decide} state="skipped" />)}
          </div>
          {!filtered(activeView === 'work' ? queue.work : [...queue.pending, ...queue.skipped]).length && <div className="dedupe-empty"><h3>{search ? 'No deals match your search' : activeView === 'work' ? 'Nothing to work on' : 'Nothing identical to the website'}</h3><p>{activeView === 'work' && !search ? 'Every incoming deal is already on the site.' : 'Your other list is available above.'}</p></div>}
          {!!queue.excluded.length && <details className="dedupe-disclosure"><summary>Excluded by ending-today policy · {queue.excluded.length}</summary>{queue.excluded.map(row => <p key={row.hq.id} className="review-hint">{row.hq.vendor} · {row.hq.text}</p>)}</details>}
        </section>
      ) : <div className="dedupe-empty"><h3>{lastRun && lastRun.matcherVersion !== MATCHER_VERSION ? 'Matching has improved — compare again' : 'Load your website export, then compare'}</h3><p>{lastRun && lastRun.matcherVersion !== MATCHER_VERSION ? 'Your inputs are saved. Run a fresh comparison before reviewing the updated candidates.' : 'Your saved source and website file stay here while you move between steps.'}</p></div>}
    </div>
  );
}

const STATUS_GLYPH = { same: '✓', different: '✗', partial: '~', unknown: '?', 'n/a': '–' };

function MarkerChecklist({ checks }) {
  if (!checks?.length) return null;
  return <table className="marker-checklist">
    <thead><tr><th>Marker</th><th>Incoming</th><th>Website</th></tr></thead>
    <tbody>
      {checks.map(check => <tr key={check.key} className={`marker-${check.status}`}>
        <th scope="row"><span className="marker-glyph" aria-hidden="true">{STATUS_GLYPH[check.status] || '?'}</span>{check.label}</th>
        <td>{check.hq}</td>
        <td>{check.web}</td>
      </tr>)}
    </tbody>
  </table>;
}

function differenceSummary(r) {
  if (!r.web) return r.meta?.noWebDeals ? 'This supplier has no deals on the website yet.' : 'No similar deal on the website for this supplier.';
  if (r.meta?.operatorRejectedMatch) return 'You pulled this into the work list.';
  const labels = { type: 'type of offer', exclusive: 'exclusivity', expiry: 'expiry date', dollars: 'amounts', percents: 'percentages', nights: 'nights' };
  const diffs = (r.meta?.differences || []).map(key => labels[key] || key);
  if (r.meta?.typeStatus === 'partial') diffs.unshift('type only partly overlaps');
  if (!diffs.length) return '';
  return `Differs on ${diffs.join(', ')}.`;
}

function MatchCard({ r, today, onDecision, state }) {
  const summary = differenceSummary(r);
  const isIdentical = state !== 'work';
  return <article className={`match-card review-card card-${state}`}>
    <div className="match-header">
      <span className="supplier-name">{r.hq.vendor}</span>
      {r.hq.type === 'exclusive' && <span className="pill pill-purple">Exclusive</span>}
      {state === 'pending' && <span className="pill pill-ok">Looks identical</span>}
      {state === 'skipped' && <span className="pill">Already on site</span>}
      {state === 'work' && !r.web && <span className="pill pill-accent">New</span>}
      {state === 'work' && r.web && <span className="pill pill-warn">Changed</span>}
      {sameDay(r.hq.end, today) && <span className="pill pill-warn">Ends today</span>}
    </div>
    {summary && <div className={`comparison-summary ${isIdentical ? 'is-quiet' : ''}`}>{summary}</div>}
    <div className="match-grid">
      <div className="match-side match-side-incoming"><h4>Incoming</h4><p className="match-text">{r.hq.text}</p><div className="match-meta">{r.hq.ongoing ? 'Ongoing' : r.hq.end ? `Ends ${dateFmt.format(r.hq.end)}` : 'No end date in source'}</div></div>
      <div className="match-side match-side-website"><h4>{r.web ? 'On the website' : 'Website'}</h4>{r.web ? <><p className="match-text">{r.web.raw?.title || r.web.text}</p><p className="website-description">{r.web.raw?.shopListing || ''}</p><div className="match-meta">{r.web.expiryDate ? `Ends ${dateFmt.format(r.web.expiryDate)}` : 'No website expiry'}</div></> : <p className="match-text match-text-empty">Nothing similar</p>}</div>
    </div>
    {r.web && <MarkerChecklist checks={r.meta?.checks} />}
    <div className="card-actions">
      {state === 'work' && <button className="btn btn-success" onClick={() => onDecision(r.hq.id, 'skip')}>Already on site</button>}
      {state === 'pending' && <><button className="btn btn-success" onClick={() => onDecision(r.hq.id, 'skip')}>Confirm · already on site</button><button className="btn btn-reject" onClick={() => onDecision(r.hq.id, 'work')}>Move to work list</button></>}
      {state === 'skipped' && <button className="btn" onClick={() => onDecision(r.hq.id, 'work')}>Move to work list</button>}
      {state === 'work' && r.meta?.operatorRejectedMatch === undefined && r.meta?.identical && <button className="btn" onClick={() => onDecision(r.hq.id, undefined)}>Undo</button>}
      {r.web && <a className="btn" href={`https://travelperks.com/admin/entries/deals?search=${encodeURIComponent(r.web.raw?.title || r.hq.vendor)}`} target="travelperks-admin" rel="noreferrer">Find on website ↗</a>}
    </div>
    {r.meta?.candidateRankings?.length > 1 && <details className="match-evidence"><summary>Other website deals for {r.hq.vendor}</summary>
      {r.meta.candidateRankings.map((candidate, index) => <p className="match-meta" key={index}><strong>{candidate.title}</strong> · {candidate.types}</p>)}</details>}
  </article>;
}
