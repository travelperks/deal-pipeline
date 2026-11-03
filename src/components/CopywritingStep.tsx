import React, { useState, useEffect, useCallback, useMemo } from "react";
import {
  parseRawToGroups,
  generatePrompt,
  generateSingleDealPrompt,
  validateAndMerge,
  cleanAndParsePatchJSON,
  applyDealPatch,
  appendDealToRawInput,
  createDealSlug,
} from "../logic/copywriting.js";

let confettiFn = null;
function loadConfetti() {
  if (confettiFn) return;
  import("canvas-confetti").then((mod) => { confettiFn = mod.default; }).catch(() => {});
}
const CONFETTI_COLORS = ["#7fe3bd", "#0b6150", "#f6b866", "#9db8ff", "#c7b4f7"];

// A small burst from the deal's check button when it is published.
function burstFrom(key) {
  if (!confettiFn) return;
  const el = document.querySelector(`[data-deal-key="${key}"] .deal-check`);
  const r = el?.getBoundingClientRect();
  const origin = r ? { x: (r.left + r.width / 2) / window.innerWidth, y: (r.top + r.height / 2) / window.innerHeight } : { x: 0.5, y: 0.5 };
  confettiFn({ particleCount: 36, spread: 60, startVelocity: 26, scalar: 0.8, ticks: 120, origin, colors: CONFETTI_COLORS, zIndex: 2000 });
}

// Fireworks when the whole queue is published.
function fireworks() {
  if (!confettiFn) return;
  const end = Date.now() + 2200;
  (function frame() {
    confettiFn({ particleCount: 6, angle: 60, spread: 70, origin: { x: 0, y: 0.7 }, colors: CONFETTI_COLORS, zIndex: 2000 });
    confettiFn({ particleCount: 6, angle: 120, spread: 70, origin: { x: 1, y: 0.7 }, colors: CONFETTI_COLORS, zIndex: 2000 });
    if (Date.now() < end) requestAnimationFrame(frame);
  })();
  setTimeout(() => confettiFn({ particleCount: 160, spread: 100, startVelocity: 45, origin: { y: 0.45 }, colors: CONFETTI_COLORS, zIndex: 2000 }), 300);
}

const FIELD_LABEL = { h: "headline", d: "description", sd: "start date", ed: "end date", slug: "URL slug" };

// The copy order the operator works in: headline, description, dates, slug.
function fieldsFor(deal, showSlug) {
  const fields = ["h", "d"];
  if (deal.startDate) fields.push("sd");
  if (deal.endDate) fields.push("ed");
  if (showSlug && deal.urlSlug) fields.push("slug");
  return fields;
}
function valueOf(deal, field) {
  return { h: deal.headline, d: deal.description, sd: deal.startDate, ed: deal.endDate, slug: deal.urlSlug }[field];
}

const blankDeal = (d) => ({
  dealId: d.dealId,
  dealIndex: d.dealIndex,
  urlSlug: createDealSlug(d.originalText),
  headline: "MISSING HEADLINE",
  description: "Needs copy. Call to speak with an agent!",
  startDate: null,
  endDate: null,
  dateNote: null,
  originalText: d.originalText,
  isExclusive: d.isExclusive,
  warnings: [{ severity: "warn", msg: "New deal added. Generate or paste copy for it." }],
  checked: false,
});

/**
 * Manages the AI-copy workflow: copy the batch prompt, paste the reply (it is
 * checked as soon as it is pasted), then move each field to the website. In
 * the queue, C copies the current deal's next field; once every field is
 * copied the deal is marked published and the next one is selected.
 */
export default function CopywritingStep({ session, onSessionChange, showToast }) {
  const { view, rawInput, jsonInput, finalGroups, houseStyle, dealNotes } = session;
  const [workFilter, setWorkFilter] = useState("pending");
  const [workSearch, setWorkSearch] = useState("");
  const [flash, setFlash] = useState(null);
  const [copied, setCopied] = useState({});
  const [cursor, setCursor] = useState(null);
  const [justDone, setJustDone] = useState(null);
  const [checkResult, setCheckResult] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [patchInput, setPatchInput] = useState("");
  const [quickAdd, setQuickAdd] = useState({ vendor: "", text: "", exclusive: false });

  useEffect(() => { loadConfetti(); }, []);

  const updateSession = useCallback((patch) => {
    onSessionChange((prev) => (typeof patch === "function" ? patch(prev) : { ...prev, ...patch }));
  }, [onSessionChange]);

  // Older sessions may lack slugs; fill them in once in the queue.
  useEffect(() => {
    if (view !== "work" || !finalGroups.some((g) => g.deals.some((d) => !d.urlSlug))) return;
    updateSession((prev) => ({
      ...prev,
      finalGroups: prev.finalGroups.map((g) => ({ ...g, deals: g.deals.map((d) => ({ ...d, urlSlug: d.urlSlug || createDealSlug(d.headline || d.originalText) })) })),
    }));
  }, [view, finalGroups, updateSession]);

  const rawGroups = useMemo(() => parseRawToGroups(rawInput), [rawInput]);
  const rawDealCount = rawGroups.reduce((n, g) => n + g.deals.length, 0);

  const handleGeneratePrompt = useCallback(() => {
    if (!rawGroups.length) {
      showToast("No suppliers found. Use 'v Name' lines.", "error");
      return;
    }
    navigator.clipboard.writeText(generatePrompt(rawGroups, houseStyle))
      .then(() => showToast(`Prompt for ${rawGroups.length} suppliers copied`, "success"))
      .catch(() => showToast("Could not copy. Please try again.", "error"));
  }, [rawGroups, houseStyle, showToast]);

  const openQueue = useCallback((data) => {
    updateSession({ finalGroups: data, view: "work" });
    setCheckResult(null);
    window.scrollTo(0, 0);
  }, [updateSession]);

  // Check the AI reply as soon as it is pasted. Only on the input view, so a
  // queue in progress is never rebuilt.
  useEffect(() => {
    if (view !== "input") return;
    if (!jsonInput.trim()) { setCheckResult(null); return; }
    const timer = setTimeout(() => {
      try {
        const result = validateAndMerge(parseRawToGroups(rawInput), jsonInput);
        if (result.error) setCheckResult({ error: result.error });
        else if (result.warnings?.length) setCheckResult({ warnings: result.warnings, data: result.data });
        else openQueue(result.data);
      } catch (e) {
        setCheckResult({ error: { title: "That reply isn't complete JSON yet", msg: e.message } });
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [view, jsonInput, rawInput, openQueue]);

  const toggleCheck = useCallback((vIdx, dIdx, forceState = null) => {
    updateSession((prev) => ({
      ...prev,
      finalGroups: prev.finalGroups.map((g, gi) => ({
        ...g,
        deals: g.deals.map((d, di) => {
          if (gi !== vIdx || di !== dIdx) return d;
          const next = forceState !== null ? forceState : !d.checked;
          if (next && !d.checked) {
            setTimeout(() => setJustDone(`${vIdx}-${dIdx}`), 0);
            const allDone = prev.finalGroups.every((group, x) => group.deals.every((deal, y) => (x === vIdx && y === dIdx) || deal.checked));
            setTimeout(() => (allDone ? fireworks() : burstFrom(`${vIdx}-${dIdx}`)), 0);
          }
          return { ...d, checked: next };
        }),
      })),
    }));
    if (forceState === false || forceState === null) setCopied((prev) => { const n = { ...prev }; delete n[`${vIdx}-${dIdx}`]; return n; });
  }, [updateSession]);

  // Copy one field; once every field of a deal is copied it is published.
  const copyField = useCallback((vIdx, dIdx, deal, field, showSlug) => {
    const key = `${vIdx}-${dIdx}`;
    navigator.clipboard.writeText(valueOf(deal, field) || "").then(() => {
      setFlash(`${key}-${field}`);
      setTimeout(() => setFlash((f) => (f === `${key}-${field}` ? null : f)), 1200);
      setCursor(key);
      setCopied((prev) => {
        const mine = { ...(prev[key] || {}), [field]: true };
        if (!deal.checked && fieldsFor(deal, showSlug).every((f) => mine[f])) toggleCheck(vIdx, dIdx, true);
        return { ...prev, [key]: mine };
      });
    }).catch(() => showToast("Could not copy. Please try again.", "error"));
  }, [toggleCheck, showToast]);

  const reset = useCallback(() => {
    updateSession({ view: "input", rawInput: "", jsonInput: "", finalGroups: [], dealNotes: {} });
    setDialog(null);
    setCheckResult(null);
    setCopied({});
  }, [updateSession]);

  const copyFixPrompt = useCallback((group, deal, note = "") => {
    const prompt = generateSingleDealPrompt({ vendorName: group.name, deal, note, currentHeadline: deal.headline, currentDescription: deal.description, houseStyle });
    navigator.clipboard.writeText(prompt).then(() => showToast("Fix prompt copied", "success"));
  }, [houseStyle, showToast]);

  const applyPatch = useCallback(() => {
    if (dialog?.type !== "patch") return;
    try {
      const nextGroups = applyDealPatch(finalGroups, cleanAndParsePatchJSON(patchInput), {
        dealId: dialog.deal.dealId,
        vendorIndex: dialog.group.vendorIndex,
        dealIndex: dialog.deal.dealIndex,
      });
      updateSession({ finalGroups: nextGroups });
      setDialog(null);
      setPatchInput("");
      showToast("Deal updated", "success");
    } catch (e) {
      showToast(e.message, "error");
    }
  }, [dialog, finalGroups, patchInput, showToast, updateSession]);

  const addDeal = useCallback(() => {
    try {
      const nextRaw = appendDealToRawInput(rawInput, { vendorName: quickAdd.vendor, dealText: quickAdd.text, isExclusive: quickAdd.exclusive });
      const patch: { rawInput: string; finalGroups?: any } = { rawInput: nextRaw };
      if (view === "work") {
        patch.finalGroups = parseRawToGroups(nextRaw).map((rawGroup) => {
          const existing = finalGroups.find((g) => g.name === rawGroup.name);
          return {
            vendorIndex: rawGroup.vendorIndex,
            name: rawGroup.name,
            deals: rawGroup.deals.map((d) => existing?.deals.find((x) => x.originalText === d.originalText) || blankDeal(d)),
          };
        });
      }
      updateSession(patch);
      setQuickAdd({ vendor: "", text: "", exclusive: false });
      setDialog(null);
      showToast("Deal added", "success");
    } catch (e) {
      showToast(e.message, "error");
    }
  }, [rawInput, quickAdd, view, finalGroups, showToast, updateSession]);

  const totalDeals = finalGroups.reduce((n, g) => n + g.deals.length, 0);
  const doneDeals = finalGroups.reduce((n, g) => n + g.deals.filter((d) => d.checked).length, 0);
  const needsAttention = (d) => !d.checked && d.warnings?.length > 0 && !d.warningsOk;
  const issueDeals = finalGroups.reduce((n, g) => n + g.deals.filter(needsAttention).length, 0);

  // "All good": the operator has looked at this deal's warnings and approves the copy.
  const clearWarnings = useCallback((vIdx, dIdx) => {
    updateSession((prev) => ({
      ...prev,
      finalGroups: prev.finalGroups.map((g, gi) => gi !== vIdx ? g : {
        ...g,
        deals: g.deals.map((d, di) => (di === dIdx ? { ...d, warningsOk: true } : d)),
      }),
    }));
  }, [updateSession]);

  const matchesFilter = useCallback((deal, group) => {
    const status = workFilter === "all" || (workFilter === "pending" && !deal.checked) || (workFilter === "done" && deal.checked) || (workFilter === "issues" && !deal.checked && deal.warnings?.length > 0 && !deal.warningsOk);
    return status && `${group.name} ${deal.headline} ${deal.originalText}`.toLowerCase().includes(workSearch.toLowerCase());
  }, [workFilter, workSearch]);

  // The visible deals in order, each with what C would copy next.
  const visible = useMemo(() => {
    const rows = [];
    finalGroups.forEach((group, vIdx) => group.deals.forEach((deal, dIdx) => {
      if (!matchesFilter(deal, group)) return;
      const action = (session.sourceActions || []).find((a) => a.vendor === group.name && a.text === deal.originalText);
      // Every deal gets a fresh URL slug, updates included.
      rows.push({ key: `${vIdx}-${dIdx}`, vIdx, dIdx, group, deal, action, showSlug: true });
    }));
    return rows;
  }, [finalGroups, matchesFilter, session.sourceActions]);
  const nextFieldOf = useCallback((row) => fieldsFor(row.deal, row.showSlug).find((f) => !copied[row.key]?.[f]) || null, [copied]);
  const current = visible.find((r) => r.key === cursor && !r.deal.checked) || visible.find((r) => !r.deal.checked) || null;

  // C copies the current deal's next field.
  useEffect(() => {
    if (view !== "work") return;
    const onKey = (event) => {
      if (event.key.toLowerCase() !== "c" || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.target instanceof HTMLElement && ["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName)) return;
      if (!current || dialog) return;
      const field = nextFieldOf(current);
      if (!field) return;
      event.preventDefault();
      copyField(current.vIdx, current.dIdx, current.deal, field, current.showSlug);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, current, dialog, nextFieldOf, copyField]);

  const dialogs = <>
    {dialog?.type === "reset" && <Dialog title="Clear the copy?" onCancel={() => setDialog(null)} onConfirm={reset} confirmText="Clear copy" danger>
      <p>The copy and your progress in this step will be cleared.</p>
    </Dialog>}
    {dialog?.type === "style" && <Dialog title="House style" onConfirm={() => setDialog(null)} confirmText="Done" wide>
      <textarea className="field-area tall" aria-label="House style" value={houseStyle} onChange={(e) => updateSession({ houseStyle: e.target.value })} spellCheck={false} />
    </Dialog>}
    {dialog?.type === "add" && <Dialog title="Add a deal" onCancel={() => setDialog(null)} onConfirm={addDeal} confirmText="Add deal">
      <label className="field-label" htmlFor="qa-vendor">Supplier</label>
      <input id="qa-vendor" className="field-input" value={quickAdd.vendor} onChange={(e) => setQuickAdd({ ...quickAdd, vendor: e.target.value })} />
      <label className="field-label" htmlFor="qa-text">Deal text</label>
      <textarea id="qa-text" className="field-area" value={quickAdd.text} onChange={(e) => setQuickAdd({ ...quickAdd, text: e.target.value })} spellCheck={false} />
      <label className="check"><input type="checkbox" checked={quickAdd.exclusive} onChange={(e) => setQuickAdd({ ...quickAdd, exclusive: e.target.checked })} /> Exclusive</label>
    </Dialog>}
    {dialog?.type === "patch" && <Dialog title={`Paste fixed copy for ${dialog.group.name}`} onCancel={() => { setDialog(null); setPatchInput(""); }} onConfirm={applyPatch} confirmText="Apply" wide>
      <p className="muted">From: {dialog.deal.originalText}</p>
      <textarea className="field-area tall" aria-label="Fixed copy JSON" value={patchInput} onChange={(e) => setPatchInput(e.target.value)} spellCheck={false}
        placeholder={'{\n  "headline": "EXCLUSIVE: Get $75 in Specialty Dining Credit",\n  "description": "Enjoy $75 in Specialty Dining Credit with this exclusive offer.",\n  "startDate": null,\n  "endDate": "03/31/2026"\n}'} />
    </Dialog>}
  </>;

  if (view === "work") {
    return (
      <div className="publish-step">
        {dialogs}
        <div className="queue-head">
          <p className="queue-count"><strong>{totalDeals - doneDeals}</strong> left to publish <span className="muted">· {doneDeals} done</span></p>
          <div className="queue-progress" role="progressbar" aria-label="Published" aria-valuemin={0} aria-valuemax={totalDeals} aria-valuenow={doneDeals}>
            <span style={{ width: `${totalDeals ? (doneDeals / totalDeals) * 100 : 0}%` }} />
          </div>
          <div className="filters" role="group" aria-label="Show">
            {[["pending", "To publish"], ["issues", `Needs attention${issueDeals ? ` (${issueDeals})` : ""}`], ["done", "Done"], ["all", "All"]].map(([value, label]) =>
              <button key={value} className="filter" aria-pressed={workFilter === value} onClick={() => setWorkFilter(value)}>{label}</button>)}
          </div>
          <input type="search" className="field-input search" aria-label="Find a deal" placeholder="Find a deal" value={workSearch} onChange={(e) => setWorkSearch(e.target.value)} />
        </div>
        <div className="hint-row">
          <p className="hint">Click any field to copy it, or press <kbd>C</kbd> to copy the next one. A deal is marked published once all its fields are copied.</p>
          <div className="queue-links">
            <button className="link" onClick={() => setDialog({ type: "add" })}>Add a deal</button>
            <button className="link" onClick={() => setDialog({ type: "style" })}>House style</button>
            <button className="link" onClick={() => setDialog({ type: "reset" })}>Clear copy</button>
          </div>
        </div>

        {!visible.length && (totalDeals && doneDeals === totalDeals
          ? <div className="all-done"><p>Everything is published.</p><p className="muted">{totalDeals} deals live this week.</p></div>
          : <p className="empty">No deals in this view.</p>)}
        {finalGroups.map((group, vIdx) => {
          const rows = visible.filter((r) => r.vIdx === vIdx);
          if (!rows.length) return null;
          return (
            <section key={group.vendorIndex || vIdx} className="supplier" aria-label={group.name}>
              <h2 className="supplier-name">
                <a href={`https://travelperks.com/admin/content/entries/deals?source=section%3A8d00284b-fc9e-4b3e-8f03-ab319af6f0db&search=${encodeURIComponent(group.name)}`} target="travelperks-admin" referrerPolicy="no-referrer">{group.name}<span className="visually-hidden"> (opens admin search)</span></a>
              </h2>
              {rows.map((row) => <DealRow
                key={row.key}
                row={row}
                isCurrent={current?.key === row.key}
                isFresh={justDone === row.key}
                copiedFields={copied[row.key] || {}}
                nextField={row.key === current?.key ? nextFieldOf(row) : null}
                flash={flash}
                note={dealNotes[row.deal.dealId || row.key] || ""}
                onSelect={() => setCursor(row.key)}
                onCopy={(field) => copyField(row.vIdx, row.dIdx, row.deal, field, row.showSlug)}
                onToggle={() => toggleCheck(row.vIdx, row.dIdx)}
                onWarningsOk={() => clearWarnings(row.vIdx, row.dIdx)}
                onNote={(text) => updateSession({ dealNotes: { ...dealNotes, [row.deal.dealId || row.key]: text } })}
                onFixPrompt={(note) => copyFixPrompt(row.group, row.deal, note)}
                onPatch={() => { setDialog({ type: "patch", group: row.group, deal: row.deal }); setPatchInput(""); }}
              />)}
            </section>
          );
        })}
      </div>
    );
  }

  return (
    <div className="publish-step">
      {dialogs}
      <div className="pair">
        <section className="pair-side" aria-labelledby="pub-in">
          <div className="pair-head">
            <h2 id="pub-in"><span className="step-num" aria-hidden="true">1</span>Copy the prompt</h2>
            <p className="muted">{rawDealCount} deals from {rawGroups.length} suppliers</p>
          </div>
          <textarea className="pair-body source" aria-labelledby="pub-in" value={rawInput} onChange={(e) => updateSession({ rawInput: e.target.value })} placeholder={"v\tSupplier\nd\tDeal text"} spellCheck={false} />
          <div className="side-actions">
            <button className="btn btn-primary" onClick={handleGeneratePrompt} disabled={!rawGroups.length}>Copy prompt</button>
          </div>
        </section>

        <section className="pair-side" aria-labelledby="pub-out">
          <div className="pair-head">
            <h2 id="pub-out"><span className="step-num" aria-hidden="true">2</span>Paste the AI's reply</h2>
            <p className="muted">It's checked as soon as you paste it.</p>
          </div>
          <textarea className="pair-body source" aria-labelledby="pub-out" aria-describedby="pub-check" value={jsonInput} onChange={(e) => updateSession({ jsonInput: e.target.value })} placeholder="Paste the reply here." spellCheck={false} />
          <div id="pub-check" className="check-result" aria-live="polite">
            {checkResult?.error && <div className="notice notice-error">
              <p><strong>{checkResult.error.title}.</strong> {checkResult.error.msg}</p>
              {checkResult.error.details && <ul>{checkResult.error.details.map((d, i) => <li key={i}>{d}</li>)}</ul>}
            </div>}
            {checkResult?.warnings && <div className="notice notice-warn">
              <p><strong>{checkResult.warnings.length === 1 ? "1 deal needs" : `${checkResult.warnings.length} deals need`} a look.</strong> You can fix these in the queue too.</p>
              <ul>{checkResult.warnings.map((item, i) => <li key={i}><strong>{item.vendorName}</strong> {item.headline || item.dealText}: {item.warnings.map((w) => w.msg).join("; ")}</li>)}</ul>
              <button className="btn btn-primary" onClick={() => openQueue(checkResult.data)}>Open the queue anyway</button>
            </div>}
          </div>
        </section>
      </div>
      <div className="step-actions">
        <button className="link" onClick={() => setDialog({ type: "add" })}>Add a deal</button>
        <button className="link" onClick={() => setDialog({ type: "style" })}>House style</button>
      </div>
    </div>
  );
}

/** One deal in the publishing queue: fields to copy, its source, and quiet fix tools. */
function DealRow({ row, isCurrent, isFresh, copiedFields, nextField, flash, note, onSelect, onCopy, onToggle, onWarningsOk, onNote, onFixPrompt, onPatch }) {
  const { deal, showSlug, key } = row;
  const fieldButton = (field, className, content) => (
    <button
      className={`copyable ${className} ${copiedFields[field] ? "is-copied" : ""} ${nextField === field ? "is-next" : ""} ${flash === `${key}-${field}` ? "is-flash" : ""}`}
      onClick={(e) => { e.stopPropagation(); onCopy(field); }}
      aria-label={`Copy ${FIELD_LABEL[field]}: ${valueOf(deal, field)}`}
    >
      {content}
      {flash === `${key}-${field}` && <span className="copied-note" aria-hidden="true">Copied</span>}
    </button>
  );
  return (
    <article data-deal-key={key} className={`deal ${isCurrent ? "is-current" : ""} ${deal.checked ? "is-done" : ""} ${isFresh && deal.checked ? "is-fresh" : ""}`} onClick={onSelect}>
      <button
        className="deal-check"
        aria-pressed={!!deal.checked}
        aria-label={deal.checked ? `Published: ${deal.headline}. Mark not published` : `Mark published: ${deal.headline}`}
        onClick={(e) => { e.stopPropagation(); onToggle(); }}
      >
        <span aria-hidden="true">{deal.checked ? "✓" : ""}</span>
      </button>
      <div className="deal-body">
        {fieldButton("h", "deal-headline", deal.headline)}
        {fieldButton("d", "deal-desc", deal.description)}
        <div className="deal-fields">
          {deal.startDate && fieldButton("sd", "chip chip-date", <>Start {deal.startDate}</>)}
          {deal.endDate && fieldButton("ed", "chip chip-date", <>End {deal.endDate}</>)}
          {showSlug && deal.urlSlug && fieldButton("slug", "chip chip-mono", deal.urlSlug)}
        </div>
        {deal.warnings?.length > 0 && !deal.warningsOk && <div className="deal-warnings">
          <ul>{deal.warnings.map((w, i) => <li key={i} className={w.severity === "error" ? "is-error" : ""}><span className="label">{w.severity === "error" ? "Error" : "Check"}</span> {w.msg}</li>)}</ul>
          <button className="deal-warnings-ok" onClick={(e) => { e.stopPropagation(); onWarningsOk(); }}>All good ✓</button>
        </div>}
        <p className="deal-source">From: {deal.originalText}{deal.isExclusive && <span className="label label-exclusive">Exclusive</span>}</p>
        <details className="deal-fix" onClick={(e) => e.stopPropagation()}>
          <summary>Fix this copy</summary>
          <textarea className="field-area" aria-label="Note for the fix prompt" value={note} onChange={(e) => onNote(e.target.value)} placeholder="Optional note, e.g. make it more customer-facing" spellCheck={false} />
          <div className="fix-actions">
            <button className="btn" onClick={() => onFixPrompt(note)}>Copy fix prompt</button>
            <button className="btn" onClick={onPatch}>Paste fixed copy</button>
          </div>
        </details>
      </div>
    </article>
  );
}

function Dialog({ title, children, onConfirm, onCancel = null, confirmText = "Confirm", wide = false, danger = false }) {
  useEffect(() => {
    const onKey = (event) => { if (event.key === "Escape") (onCancel || onConfirm)(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, onConfirm]);
  return (
    <div className="dialog-backdrop">
      <div className={`dialog ${wide ? "is-wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        {children}
        <div className="dialog-actions">
          {onCancel && <button className="btn" onClick={onCancel}>Cancel</button>}
          <button className={`btn ${danger ? "btn-danger" : "btn-primary"}`} onClick={onConfirm} autoFocus>{confirmText}</button>
        </div>
      </div>
    </div>
  );
}
