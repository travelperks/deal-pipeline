import React, { useMemo, useCallback, useEffect, useRef, useState } from 'react';
import {
  parseHQ, resetIds, ingestWebsiteJSON, runFullMatch,
  categorizeDedupeResults, exportUnmatched, sameDay, dateFmt,
  MATCHER_VERSION,
} from '../logic/dedupe.js';
import { buildReviewQueue } from '../logic/review.js';
import { validateWebsiteExport } from '../logic/dealCoreClient';

const ADMIN_SEARCH = 'https://travelperks.com/admin/content/entries/deals?source=section%3A8d00284b-fc9e-4b3e-8f03-ab319af6f0db&search=';

function parseWebsiteRows(text) {
  const data = JSON.parse(text);
  return Array.isArray(data) ? data : data.entries || data.data || [];
}

// A short fingerprint of the loaded export, so a saved comparison can be
// recognized after a reload without storing the export twice.
function signatureOf(rows) {
  const text = JSON.stringify(rows || []);
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  return `${(rows || []).length}:${hash}`;
}

function adminLink(row) {
  return row.web?.raw?.cpEditUrl || `${ADMIN_SEARCH}${encodeURIComponent(row.web?.raw?.title || row.hq.vendor)}`;
}

/**
 * Compares the tagged batch with the website export by rule and lands on one
 * number and one button: the deals to add or update. Deals already live are
 * set aside without asking and stay one tab away; the operator can move any
 * row either way. Comparison starts by itself once both inputs exist, and the
 * whole step accepts a dropped website export.
 */
export default function DedupeStep({ session, onSessionChange, onComplete, showToast }) {
  const fileRef = useRef(null);
  const [importError, setImportError] = useState('');
  const [dragging, setDragging] = useState(false);
  const [search, setSearch] = useState('');
  const decisions = session.decisions || {};
  const view = session.viewFilter === 'identical' ? 'identical' : 'work';
  const { hqText, websiteRows, lastRun, supplierFilter, restrictToday } = session;

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

  const webSignature = useMemo(() => signatureOf(websiteRows), [websiteRows]);
  const canCompare = hqDeals.length > 0 && websiteRows.length > 0;
  const current = !!lastRun && lastRun.matcherVersion === MATCHER_VERSION
    && lastRun.hqText === hqText && lastRun.webSignature === webSignature
    && (lastRun.supplierFilter || '') === (supplierFilter || '');

  // Compare as soon as both inputs exist; any change to either starts over.
  useEffect(() => {
    if (!canCompare || current) return;
    updateSession({
      lastRun: { matcherVersion: MATCHER_VERSION, hqText, webSignature, supplierFilter },
      decisions: {},
      viewFilter: 'work',
    });
  }, [canCompare, current, hqText, webSignature, supplierFilter, updateSession]);

  const results = useMemo(() => {
    if (!canCompare || !current) return null;
    resetIds();
    return runFullMatch(parseHQ(hqText), ingestWebsiteJSON(websiteRows), { filterSupplier: supplierFilter });
  }, [canCompare, current, hqText, websiteRows, supplierFilter]);

  const categorized = useMemo(
    () => (results ? categorizeDedupeResults(results, { excludeEndingToday: restrictToday }) : null),
    [results, restrictToday],
  );
  const queue = useMemo(() => buildReviewQueue(categorized, decisions), [categorized, decisions]);
  const endingToday = useMemo(
    () => (results || []).filter((row) => sameDay(row.hq.end, new Date()) && !row.meta?.identical).length,
    [results],
  );
  const webSuppliers = useMemo(
    () => [...new Set(ingestWebsiteJSON(websiteRows).map((deal) => deal.supplier))].sort(),
    [websiteRows],
  );
  const dateWarnings = useMemo(() => hqDeals.filter((deal) => deal.dateWarning), [hqDeals]);

  const decide = (id, value) => {
    const next = { ...decisions };
    if (value === undefined) delete next[id]; else next[id] = value;
    updateSession({ decisions: next });
  };

  const loadExport = useCallback(async (file) => {
    if (!file) return;
    try {
      const rows = parseWebsiteRows(await file.text());
      const validation = await validateWebsiteExport(rows);
      if ('error' in validation) {
        setImportError(validation.error.message);
        showToast('Website export not recognized', 'error');
        return;
      }
      setImportError('');
      updateSession({ websiteRows: validation.data.rows, websiteFileName: file.name, lastRun: null, decisions: {} });
      showToast(`${validation.data.recognizedCount} website deals loaded`, 'success');
    } catch (error) {
      setImportError(`That file isn't a website export (${error instanceof Error ? error.message : String(error)}).`);
      showToast('Could not read that file', 'error');
    }
  }, [showToast, updateSession]);

  const dropProps = {
    onDragOver: (event) => { event.preventDefault(); setDragging(true); },
    onDragLeave: () => setDragging(false),
    onDrop: (event) => { event.preventDefault(); setDragging(false); loadExport(event.dataTransfer.files?.[0]); },
  };
  const fileInput = <input ref={fileRef} type="file" accept=".json" hidden onChange={(event) => { loadExport(event.target.files?.[0]); event.target.value = ''; }} />;

  const handleCopyList = async () => {
    try {
      await navigator.clipboard.writeText(exportUnmatched(queue.work.map(row => row.hq)));
      showToast('List copied', 'success');
    } catch { showToast('Clipboard unavailable. Please try again.', 'error'); }
  };
  // Every row takes the same path through Publish. A likely update only
  // carries a label and a link to the entry it may replace.
  const handleSend = () => {
    if (!queue.work.length) return;
    onComplete(exportUnmatched(queue.work.map(row => row.hq)), queue.work.map(row => {
      const update = row.web && row.meta?.verdict === 'update' && decisions[row.hq.id] !== 'work';
      return {
        vendor: row.hq.vendor,
        text: row.hq.text,
        action: update ? 'update' : 'new',
        websiteTitle: update ? row.web.raw?.title || '' : '',
        websiteUrl: update ? adminLink(row) : '',
        reason: update ? row.meta.reason : '',
      };
    }));
  };

  if (!hqDeals.length) {
    return <div className="cmp-empty"><p className="cmp-empty-head">Nothing to compare yet.</p><p className="cmp-empty-sub">Tag this week's deals first.</p></div>;
  }

  if (!websiteRows.length) {
    return <div className={`cmp-empty cmp-drop ${dragging ? 'is-dragging' : ''}`} {...dropProps} onClick={() => fileRef.current?.click()} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') fileRef.current?.click(); }} role="button" tabIndex={0}>
      <p className="cmp-empty-head">Drop this week's website export here.</p>
      <p className={`cmp-empty-sub ${importError ? 'is-error' : ''}`}>{importError || `Or click anywhere to choose it. ${hqDeals.length} tagged deals are waiting.`}</p>
      {fileInput}
    </div>;
  }

  if (!categorized) return <div className="cmp-empty"><p className="cmp-empty-head">Comparing…</p></div>;

  const rows = view === 'work' ? queue.work : queue.skipped;
  const needle = search.trim().toLowerCase();
  const shown = needle
    ? rows.filter((row) => `${row.hq.vendor} ${row.hq.text} ${row.web?.raw?.title || ''}`.toLowerCase().includes(needle))
    : rows;
  const groups = [];
  for (const row of shown) {
    const last = groups[groups.length - 1];
    if (last && last.vendor === row.hq.vendor) last.rows.push(row);
    else groups.push({ vendor: row.hq.vendor, rows: [row] });
  }
  const updates = queue.work.filter((row) => row.web && row.meta?.verdict === 'update' && decisions[row.hq.id] !== 'work').length;
  const total = queue.work.length + queue.skipped.length + queue.excluded.length;

  return (
    <div className={`cmp ${dragging ? 'is-dragging' : ''}`} {...dropProps}>
      <section className="cmp-hero">
        <div className="cmp-hero-copy">
          <h3>{queue.work.length ? `${queue.work.length} ${queue.work.length === 1 ? 'deal' : 'deals'} to add or update` : 'Nothing to add or update'}</h3>
          <p>
            {queue.skipped.length} of {total} are already on the site and were set aside.
            {updates > 0 && ` ${updates} of the ${queue.work.length} may be updates to entries that are already there.`}
            {queue.excluded.length > 0 && ` ${queue.excluded.length} ending today left out.`}
          </p>
          <div className="cmp-hero-meta">
            <button className="cmp-link" onClick={() => fileRef.current?.click()}>Replace {session.websiteFileName || 'website export'}</button>
            {(endingToday > 0 || restrictToday) && <label className="cmp-check"><input type="checkbox" checked={!!restrictToday} onChange={() => updateSession({ restrictToday: !restrictToday })} /> Leave out {endingToday} ending today</label>}
            {importError && <span className="cmp-error" role="alert">{importError}</span>}
          </div>
        </div>
        <div className="cmp-hero-actions">
          <button className="btn btn-forward cmp-send" disabled={!queue.work.length} onClick={handleSend}>Send {queue.work.length} to Publish →</button>
          <button className="cmp-link" disabled={!queue.work.length} onClick={handleCopyList}>Copy as text</button>
        </div>
        {fileInput}
      </section>

      {dateWarnings.length > 0 && (
        <details className="dedupe-disclosure warning-disclosure">
          <summary>{dateWarnings.length} date {dateWarnings.length === 1 ? 'warning' : 'warnings'} need review</summary>
          {dateWarnings.map((deal, index) => <div key={index} className="date-warning"><strong>{deal.vendor}:</strong> {deal.dateWarning}<div className="mini">{deal.text}</div></div>)}
        </details>
      )}

      <div className="cmp-bar">
        <div className="cmp-tabs" role="tablist" aria-label="Comparison lists">
          <button role="tab" aria-selected={view === 'work'} className={view === 'work' ? 'is-active' : ''} onClick={() => updateSession({ viewFilter: 'work' })}>To add or update <span>{queue.work.length}</span></button>
          <button role="tab" aria-selected={view === 'identical'} className={view === 'identical' ? 'is-active' : ''} onClick={() => updateSession({ viewFilter: 'identical' })}>Already on the site <span>{queue.skipped.length}</span></button>
        </div>
        <input className="cmp-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find a supplier or offer…" aria-label="Find a deal" />
      </div>

      {!shown.length && <div className="cmp-none">{needle ? 'No deals match your search.' : view === 'work' ? 'Every incoming deal is already on the site.' : 'Nothing was set aside.'}</div>}

      {groups.map((group) => (
        <section key={group.vendor} className="cmp-group">
          <h4><a href={`${ADMIN_SEARCH}${encodeURIComponent(group.vendor)}`} target="travelperks-admin" referrerPolicy="no-referrer" title={`Open ${group.vendor} deals in the website admin`}>{group.vendor}</a><span>{group.rows.length}</span></h4>
          {group.rows.map((row) => <DealRow key={row.hq.id} row={row} view={view} decision={decisions[row.hq.id]} onDecision={decide} />)}
        </section>
      ))}

      {queue.excluded.length > 0 && <details className="dedupe-disclosure"><summary>Left out because they end today · {queue.excluded.length}</summary>{queue.excluded.map(row => <p key={row.hq.id} className="review-hint">{row.hq.vendor} · {row.hq.text}</p>)}</details>}

      <details className="dedupe-disclosure">
        <summary>Options</summary>
        <div className="advanced-grid">
          <label className="advanced-source"><span>Tagged source</span><textarea value={hqText} onChange={(event) => updateSession({ hqText: event.target.value, lastRun: null, decisions: {} })} spellCheck={false} /></label>
          <div className="advanced-controls">
            <label className="mini-label">Supplier <select value={supplierFilter} onChange={(event) => updateSession({ supplierFilter: event.target.value, lastRun: null, decisions: {} })}><option value="">All suppliers</option>{webSuppliers.map((supplier) => <option key={String(supplier)}>{String(supplier)}</option>)}</select></label>
          </div>
        </div>
      </details>
    </div>
  );
}

const GLYPH = { same: '✓', different: '✗', 'n/a': '–' };

function DealRow({ row, view, decision, onDecision }) {
  const [open, setOpen] = useState(false);
  const moved = decision === (view === 'work' ? 'work' : 'skip');
  const verdict = row.meta?.verdict;
  const isUpdate = view === 'work' && row.web && verdict === 'update' && !moved;
  const reason = moved
    ? (view === 'work' ? 'You moved this back onto the list.' : 'You set this aside.')
    : (view === 'identical' || isUpdate) ? row.meta?.reason : '';
  return (
    <article className={`cmp-row ${isUpdate ? 'is-update' : ''}`}>
      <div className="cmp-row-main">
        <p className="cmp-row-text">
          {row.hq.type === 'exclusive' && <span className="pill pill-purple">Exclusive</span>}
          {isUpdate && <span className="pill pill-warn">Possible update</span>}
          {sameDay(row.hq.end, new Date()) && <span className="pill">Ends today</span>}
          {row.hq.text}
        </p>
        {reason && <p className="cmp-row-why">{reason}</p>}
        {row.web && (view === 'identical' || isUpdate) && (
          <p className="cmp-row-site">
            <span>On the site</span>
            <a href={adminLink(row)} target="travelperks-admin" referrerPolicy="no-referrer">{row.web.raw?.title || row.web.text} ↗</a>
            <em>{row.web.expiryDate ? `ends ${dateFmt.format(row.web.expiryDate)}` : 'no end date'}</em>
            {row.meta?.checks?.length > 0 && <button className="cmp-link" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? 'Hide comparison' : 'Compare'}</button>}
          </p>
        )}
        {open && row.web && (
          <table className="cmp-checks">
            <thead><tr><th></th><th>This deal</th><th>Site entry</th></tr></thead>
            <tbody>{row.meta.checks.map((check) => (
              <tr key={check.key} className={`is-${check.status}`}><th scope="row"><span aria-hidden="true">{GLYPH[check.status] || '–'}</span> {check.label}</th><td>{check.hq}</td><td>{check.web}</td></tr>
            ))}</tbody>
          </table>
        )}
      </div>
      {view === 'work'
        ? <button className="btn cmp-row-action" onClick={() => onDecision(row.hq.id, row.meta?.identical ? undefined : 'skip')}>Already on site</button>
        : <button className="btn cmp-row-action" onClick={() => onDecision(row.hq.id, row.meta?.identical ? 'work' : undefined)}>Add to list</button>}
    </article>
  );
}
