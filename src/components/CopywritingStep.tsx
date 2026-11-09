import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
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

let confettiLoaded = false;
let confettiFn = null;

function loadConfetti() {
  if (confettiLoaded) return Promise.resolve(confettiFn);
  return import("canvas-confetti")
    .then((mod) => {
      confettiFn = mod.default;
      confettiLoaded = true;
      return confettiFn;
    })
    .catch(() => null);
}

function fireConfetti() {
  if (confettiFn) {
    confettiFn({
      particleCount: 100,
      spread: 70,
      origin: { y: 0.6 },
      colors: ["#3b82f6", "#10b981", "#8b5cf6", "#f97316"],
      zIndex: 2000,
      disableForReducedMotion: true,
    });
  }
}

/**
 * Manages the manual AI-copy workflow from prompt generation through lint
 * review, targeted repair, completion tracking, and field-by-field clipboard
 * handoff. Generated copy remains session data until the operator explicitly
 * accepts warnings and checks each deal complete.
 */
export default function CopywritingStep({ session, onSessionChange, showToast }) {
  const { view, rawInput, jsonInput, finalGroups, houseStyle, dealNotes } = session;
  const [workFilter, setWorkFilter] = useState("pending");
  const [workSearch, setWorkSearch] = useState("");
  const [copySuccess, setCopySuccess] = useState({});
  const [validationError, setValidationError] = useState(null);
  const [validationWarnings, setValidationWarnings] = useState(null);
  const [pendingData, setPendingData] = useState(null);
  const [showReset, setShowReset] = useState(false);
  const [showStyleEditor, setShowStyleEditor] = useState(false);
  const [expandedNotes, setExpandedNotes] = useState({});
  const [patchModal, setPatchModal] = useState(null);
  const [patchInput, setPatchInput] = useState("");
  const [showQuickAdd, setShowQuickAdd] = useState(false);
  const [quickAddVendor, setQuickAddVendor] = useState("");
  const [quickAddDealText, setQuickAddDealText] = useState("");
  const [quickAddExclusive, setQuickAddExclusive] = useState(false);

  useEffect(() => {
    loadConfetti();
  }, []);

  const updateSession = useCallback(
    (patch) => {
      onSessionChange((prev) => (
        typeof patch === "function" ? patch(prev) : { ...prev, ...patch }
      ));
    },
    [onSessionChange],
  );

  useEffect(() => {
    if (
      view !== "work" ||
      !finalGroups.some((group) => group.deals.some((deal) => !deal.urlSlug))
    ) return;

    updateSession((prev) => ({
      ...prev,
      finalGroups: prev.finalGroups.map((group) => ({
        ...group,
        deals: group.deals.map((deal) => ({
          ...deal,
          urlSlug: deal.urlSlug || createDealSlug(deal.headline || deal.originalText),
        })),
      })),
    }));
  }, [view, finalGroups, updateSession]);

  const handleGeneratePrompt = useCallback(() => {
    const groups = parseRawToGroups(rawInput);
    if (groups.length === 0) {
      showToast("No vendors found. Use 'v Name' format.", "error");
      return;
    }
    const prompt = generatePrompt(groups, houseStyle);
    navigator.clipboard.writeText(prompt).then(() => {
      showToast(`Prompt for ${groups.length} vendors copied`, "success");
    });
  }, [rawInput, houseStyle, showToast]);

  const handleValidate = useCallback(() => {
    try {
      const rawGroups = parseRawToGroups(rawInput);
      const result = validateAndMerge(rawGroups, jsonInput);

      if (result.error) {
        setValidationError(result.error);
        return;
      }

      if (result.warnings && result.warnings.length > 0) {
        setValidationWarnings(result.warnings);
        setPendingData(result.data);
        return;
      }

      updateSession({
        finalGroups: result.data,
        view: "work",
      });
      window.scrollTo(0, 0);
    } catch (e) {
      showToast("JSON Syntax Error: " + e.message, "error");
    }
  }, [jsonInput, rawInput, showToast, updateSession]);

  const handleProceedPastGate = useCallback(() => {
    if (pendingData) {
      updateSession({
        finalGroups: pendingData,
        view: "work",
      });
      setValidationWarnings(null);
      setPendingData(null);
      window.scrollTo(0, 0);
    }
  }, [pendingData, updateSession]);

  const handleCancelGate = useCallback(() => {
    setValidationWarnings(null);
    setPendingData(null);
  }, []);

  // Tracks which copyable fields have been clicked per deal, so page 3 can
  // auto-mark a deal published once every field has been copied.
  const copiedFieldsRef = useRef({});

  const toggleCheck = useCallback((vIdx, dIdx, forceState = null) => {
    updateSession((prev) => ({
      ...prev,
      finalGroups: prev.finalGroups.map((g, gi) => ({
        ...g,
        deals: g.deals.map((d, di) => {
          if (gi === vIdx && di === dIdx) {
            const next = forceState !== null ? forceState : !d.checked;
            // Reopening clears the copy tracker so the next full pass re-arms auto-mark.
            if (!next) delete copiedFieldsRef.current[`${vIdx}-${dIdx}`];
            if (next && prev.finalGroups.every((group, groupIndex) => group.deals.every((deal, dealIndex) => (groupIndex === vIdx && dealIndex === dIdx) || deal.checked))) fireConfetti();
            return { ...d, checked: next };
          }
          return d;
        }),
      })),
    }));
  }, [updateSession]);

  // autoMark: { field, vIdx, dIdx, deal, showSlug } — once every copyable field
  // on that deal has been clicked, mark it published automatically.
  const handleCopy = useCallback((text, key, autoMark = null) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopySuccess((prev) => ({ ...prev, [key]: true }));
      if (autoMark) {
        const { field, vIdx, dIdx, deal, showSlug } = autoMark;
        const dealKey = `${vIdx}-${dIdx}`;
        const copied = { ...(copiedFieldsRef.current[dealKey] || {}), [field]: true };
        copiedFieldsRef.current[dealKey] = copied;
        const required = ["h", "d"];
        if (deal.startDate) required.push("sd");
        if (deal.endDate) required.push("ed");
        if (showSlug && deal.urlSlug) required.push("slug");
        if (required.every((f) => copied[f])) toggleCheck(vIdx, dIdx, true);
      }
      setTimeout(() => {
        setCopySuccess((prev) => {
          const n = { ...prev };
          delete n[key];
          return n;
        });
      }, 1500);
    }).catch(() => showToast("Could not copy. Please try again.", "error"));
  }, [toggleCheck, showToast]);

  const reset = useCallback(() => {
    updateSession({
      view: "input",
      rawInput: "",
      jsonInput: "",
      finalGroups: [],
      dealNotes: {},
    });
    setShowReset(false);
    setValidationWarnings(null);
    setPendingData(null);
    setPatchModal(null);
    setPatchInput("");
    setExpandedNotes({});
  }, [updateSession]);

  const handleSingleDealPrompt = useCallback(
    (group, deal, note = "") => {
      const prompt = generateSingleDealPrompt({
        vendorName: group.name,
        deal,
        note,
        currentHeadline: deal.headline,
        currentDescription: deal.description,
        houseStyle,
      });
      navigator.clipboard.writeText(prompt).then(() => {
        showToast(`Prompt copied for ${deal.dealId}`, "success");
      });
    },
    [houseStyle, showToast],
  );

  const handlePatchApply = useCallback(() => {
    if (!patchModal) return;
    try {
      const parsed = cleanAndParsePatchJSON(patchInput);
      const nextGroups = applyDealPatch(finalGroups, parsed, {
        dealId: patchModal.deal.dealId,
        vendorIndex: patchModal.group.vendorIndex,
        dealIndex: patchModal.deal.dealIndex,
      });
      updateSession({ finalGroups: nextGroups });
      setPatchModal(null);
      setPatchInput("");
      showToast("Deal updated", "success");
    } catch (e) {
      showToast(e.message, "error");
    }
  }, [finalGroups, patchInput, patchModal, showToast, updateSession]);

  const handleQuickAdd = useCallback(() => {
    try {
      const nextRaw = appendDealToRawInput(rawInput, {
        vendorName: quickAddVendor,
        dealText: quickAddDealText,
        isExclusive: quickAddExclusive,
      });
      const nextSessionPatch: { rawInput: string; finalGroups?: any } = { rawInput: nextRaw };

      if (view === "work") {
        const groups = parseRawToGroups(nextRaw);
        const nextGroups = groups.map((rawGroup) => {
          const existingGroup = finalGroups.find(
            (g) => g.name === rawGroup.name,
          );
          if (!existingGroup) {
            return {
              vendorIndex: rawGroup.vendorIndex,
              name: rawGroup.name,
              deals: rawGroup.deals.map((d) => ({
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
                warnings: [
                  {
                    severity: "warn",
                    msg: "New deal added. Generate or paste copy for this row.",
                  },
                ],
                checked: false,
              })),
            };
          }

          const mergedDeals = rawGroup.deals.map((rawDeal) => {
            const existingDeal = existingGroup.deals.find(
              (d) => d.originalText === rawDeal.originalText,
            );
            return (
              existingDeal || {
                dealId: rawDeal.dealId,
                dealIndex: rawDeal.dealIndex,
                urlSlug: createDealSlug(rawDeal.originalText),
                headline: "MISSING HEADLINE",
                description: "Needs copy. Call to speak with an agent!",
                startDate: null,
                endDate: null,
                dateNote: null,
                originalText: rawDeal.originalText,
                isExclusive: rawDeal.isExclusive,
                warnings: [
                  {
                    severity: "warn",
                    msg: "New deal added. Generate or paste copy for this row.",
                  },
                ],
                checked: false,
              }
            );
          });

          return {
            vendorIndex: rawGroup.vendorIndex,
            name: rawGroup.name,
            deals: mergedDeals,
          };
        });
        nextSessionPatch.finalGroups = nextGroups;
      }

      updateSession(nextSessionPatch);

      setQuickAddVendor("");
      setQuickAddDealText("");
      setQuickAddExclusive(false);
      setShowQuickAdd(false);
      showToast("Deal added", "success");
    } catch (e) {
      showToast(e.message, "error");
    }
  }, [
    rawInput,
    quickAddVendor,
    quickAddDealText,
    quickAddExclusive,
    view,
    finalGroups,
    showToast,
    updateSession,
  ]);

  const totalDeals = finalGroups.reduce((acc, g) => acc + g.deals.length, 0);
  const doneDeals = finalGroups.reduce(
    (acc, g) => acc + g.deals.filter((d) => d.checked).length,
    0,
  );

  const warningCounts = useMemo(() => {
    let errors = 0;
    let warns = 0;
    finalGroups.forEach((g) =>
      g.deals.forEach((d) => {
        (d.warnings || []).forEach((w) => {
          if (w.severity === "error") errors++;
          else warns++;
        });
      }),
    );
    return { errors, warns };
  }, [finalGroups]);

  const matchesFilter = (deal, group) => {
    const status = workFilter === "all" || (workFilter === "pending" && !deal.checked) || (workFilter === "done" && deal.checked) || (workFilter === "issues" && !deal.checked && deal.warnings?.length > 0);
    return status && `${group.name} ${deal.headline} ${deal.originalText}`.toLowerCase().includes(workSearch.toLowerCase());
  };
  if (view === "work") {
    return (
      <div className="copy-step">
        <div className="copy-toolbar">
          <div className="copy-toolbar-left">
            <button className="btn" onClick={() => setShowReset(true)}>
              ← Start Over
            </button>
            <button className="btn" onClick={() => setShowQuickAdd(true)}>
              + Quick Add Deal
            </button>
            <button className="btn" onClick={() => setShowStyleEditor(true)}>
              Edit House Style
            </button>
          </div>
          <div className="stat-pills">
            <span className="pill">Vendors: {finalGroups.length}</span>
            <span className="pill pill-accent">
              Deals: {doneDeals} / {totalDeals}
            </span>
            {warningCounts.errors > 0 && (
              <span className="pill pill-bad">
                {warningCounts.errors} errors
              </span>
            )}
            {warningCounts.warns > 0 && (
              <span className="pill pill-warn">
                {warningCounts.warns} warnings
              </span>
            )}
          </div>
        </div>

        {showReset && (
          <Modal
            title="Start Over?"
            onConfirm={reset}
            onCancel={() => setShowReset(false)}
            confirmText="Yes, Reset"
          >
            <p>All current progress will be lost.</p>
          </Modal>
        )}

        {showStyleEditor && (
          <Modal
            title="House Style"
            onConfirm={() => setShowStyleEditor(false)}
            onCancel={() => setShowStyleEditor(false)}
            confirmText="Done"
            wide
          >
            <textarea
              value={houseStyle}
              onChange={(e) => updateSession({ houseStyle: e.target.value })}
              className="modal-textarea"
              spellCheck={false}
            />
          </Modal>
        )}

        {showQuickAdd && (
          <Modal
            title="Quick Add Deal"
            onConfirm={handleQuickAdd}
            onCancel={() => setShowQuickAdd(false)}
            confirmText="Add Deal"
          >
            <div className="mini-form">
              <label className="mini-form-label">Vendor</label>
              <input
                className="mini-input"
                value={quickAddVendor}
                onChange={(e) => setQuickAddVendor(e.target.value)}
              />
              <label className="mini-form-label">Deal text</label>
              <textarea
                className="modal-textarea modal-textarea-short"
                value={quickAddDealText}
                onChange={(e) => setQuickAddDealText(e.target.value)}
                spellCheck={false}
              />
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={quickAddExclusive}
                  onChange={(e) => setQuickAddExclusive(e.target.checked)}
                />
                Mark as exclusive
              </label>
            </div>
          </Modal>
        )}

        {patchModal && (
          <Modal
            title={`Patch ${patchModal.deal.dealId}`}
            onConfirm={handlePatchApply}
            onCancel={() => {
              setPatchModal(null);
              setPatchInput("");
            }}
            confirmText="Apply Patch"
            wide
          >
            <div className="patch-context">
              <div className="patch-source">
                <strong>Source:</strong> {patchModal.deal.originalText}
              </div>
              <div className="patch-current">
                <strong>Current headline:</strong> {patchModal.deal.headline}
              </div>
              <div className="patch-current">
                <strong>Current description:</strong>{" "}
                {patchModal.deal.description}
              </div>
            </div>
            <textarea
              className="modal-textarea"
              value={patchInput}
              onChange={(e) => setPatchInput(e.target.value)}
              placeholder={`Paste a mini patch, for example:
{
  "headline": "EXCLUSIVE: Get $75 in Specialty Dining Credit",
  "description": "Enjoy $75 in Specialty Dining Credit with this exclusive offer.",
  "startDate": null,
  "endDate": "03/31/2026"
}`}
              spellCheck={false}
            />
          </Modal>
        )}

        <div className="review-toolbar copy-review-toolbar">
          <div className="review-tabs">{[["pending", "To publish"], ["issues", "Needs attention"], ["done", "Done"], ["all", "All deals"]].map(([value, label]) => <button key={value} className={`btn ${workFilter === value ? 'btn-accent' : ''}`} onClick={() => setWorkFilter(value)}>{label}</button>)}</div>
          <label className="review-search">Find a deal<input value={workSearch} onChange={e => setWorkSearch(e.target.value)} placeholder="Supplier or offer…" /></label>
          <span className="pill">{totalDeals - doneDeals} left to publish</span>
        </div>
        <p className="review-hint">Copy each field, paste it into the website, then mark the deal done. Copying a description does not mark it published.</p>
        {!finalGroups.some(g => g.deals.some(d => matchesFilter(d, g))) && <div className="dedupe-empty"><h3>No deals in this view</h3><p>Choose another filter or clear your search.</p></div>}
        {finalGroups.map((group, vIdx) => group.deals.some(deal => matchesFilter(deal, group)) && (
          <div key={group.vendorIndex || vIdx} className="vendor-block">
            <h2 className="vendor-block-title">
              <a
                className="vendor-block-link"
                href={`https://travelperks.com/admin/content/entries/deals?source=section%3A8d00284b-fc9e-4b3e-8f03-ab319af6f0db&search=${encodeURIComponent(group.name)}`}
                target="travelperks-admin"
                referrerPolicy="no-referrer"
                title={`Search "${group.name}" in TravelPerks admin`}
              >
                {group.name}
              </a>
            </h2>
            <div className="deal-list">
              {group.deals.map((deal, dIdx) => {
                if (!matchesFilter(deal, group)) return null;
                const sourceAction = (session.sourceActions || []).find(item => item.vendor === group.name && item.text === deal.originalText);
                const showSlug = sourceAction?.action !== "update";
                const noteKey = deal.dealId || `${vIdx}-${dIdx}`;
                return (
                  <div
                    key={deal.dealId || dIdx}
                    className={`deal-row ${deal.checked ? "deal-checked" : ""}`}
                  >
                    <button
                      aria-label={deal.checked ? "Mark deal unfinished" : "Mark deal published"}
                      title={deal.checked ? "Mark unfinished" : "Mark published"}
                      className="deal-check"
                      onClick={() => toggleCheck(vIdx, dIdx)}
                    >
                      <div
                        className={`circle-check ${deal.checked ? "circle-active" : ""}`}
                      >
                        {deal.checked && "✓"}
                      </div>
                    </button>

                    <div className="deal-content">
                      {deal.warnings && deal.warnings.length > 0 && (
                        <div className="deal-warnings">
                          {deal.warnings.map((w, wi) => (
                            <div
                              key={wi}
                              className={`deal-warning deal-warning-${w.severity}`}
                            >
                              {w.severity === "error" ? "🚨" : "⚠️"} {w.msg}
                            </div>
                          ))}
                        </div>
                      )}

                      {sourceAction?.action === 'update' && <div className="comparison-alert">Update existing website deal: <a href={`https://travelperks.com/admin/content/entries/deals?source=section%3A8d00284b-fc9e-4b3e-8f03-ab319af6f0db&search=${encodeURIComponent(sourceAction.websiteTitle || group.name)}`} target="travelperks-admin" rel="noreferrer">{sourceAction.websiteTitle || group.name} ↗</a> · Keep its existing URL.</div>}
                      <div className="deal-meta-row">
                        <span className="pill">{deal.dealId}</span>
                        {deal.isExclusive && (
                          <span className="pill pill-bad">EXCLUSIVE</span>
                        )}
                      </div>

                      <div className="deal-line">
                        <span
                          className={`copy-text deal-headline ${deal.isExclusive ? "deal-exclusive" : ""}`}
                          onClick={() =>
                            handleCopy(deal.headline, `h-${vIdx}-${dIdx}`, {
                              field: "h",
                              vIdx,
                              dIdx,
                              deal,
                              showSlug,
                            })
                          }
                        >
                          {deal.headline}
                        </span>
                        {copySuccess[`h-${vIdx}-${dIdx}`] && (
                          <span className="copied-badge">Copied</span>
                        )}
                      </div>

                      <div className="deal-line">
                        <span
                          className="copy-text deal-desc"
                          onClick={() =>
                            handleCopy(
                              deal.description,
                              `d-${vIdx}-${dIdx}`,
                              { field: "d", vIdx, dIdx, deal, showSlug },
                            )
                          }
                        >
                          {deal.description}
                        </span>
                        {copySuccess[`d-${vIdx}-${dIdx}`] && (
                          <span className="copied-badge">Copied</span>
                        )}
                      </div>

                      <div className="original-context">
                        <span className="context-label">ORIGINAL:</span>{" "}
                        {deal.originalText}
                      </div>

                      <div className="dates-row">
                        {deal.startDate && (
                          <button
                            className="date-pill date-start"
                            onClick={() =>
                              handleCopy(deal.startDate, `sd-${vIdx}-${dIdx}`, { field: "sd", vIdx, dIdx, deal, showSlug })
                            }
                          >
                            Copy start: {deal.startDate}
                          </button>
                        )}
                        {deal.endDate && (
                          <button
                            className="date-pill date-end"
                            onClick={() =>
                              handleCopy(deal.endDate, `ed-${vIdx}-${dIdx}`, { field: "ed", vIdx, dIdx, deal, showSlug })
                            }
                          >
                            Copy end: {deal.endDate}
                          </button>
                        )}
                        {showSlug && <button
                          className="date-pill slug-pill"
                          title="Click to copy URL slug"
                          onClick={() =>
                            handleCopy(deal.urlSlug, `slug-${vIdx}-${dIdx}`, { field: "slug", vIdx, dIdx, deal, showSlug })
                          }
                        >
                          Copy URL slug · {deal.urlSlug}
                        </button>}
                        {(copySuccess[`sd-${vIdx}-${dIdx}`] ||
                          copySuccess[`ed-${vIdx}-${dIdx}`] ||
                          copySuccess[`slug-${vIdx}-${dIdx}`]) && (
                          <span className="copied-badge">Copied</span>
                        )}
                      </div>

                      <div className="publish-fields">
                        <button className="btn btn-success btn-small" onClick={() => toggleCheck(vIdx, dIdx)}>{deal.checked ? 'Reopen deal' : 'Mark published ✓'}</button>
                      </div>
                      <div className="deal-actions">
                        <button
                          className="btn btn-small"
                          onClick={() =>
                            handleSingleDealPrompt(group, deal, "")
                          }
                        >
                          Copy Fix Prompt
                        </button>
                        <button
                          className="btn btn-small"
                          onClick={() =>
                            setExpandedNotes((prev) => ({
                              ...prev,
                              [noteKey]: !prev[noteKey],
                            }))
                          }
                        >
                          {expandedNotes[noteKey]
                            ? "Hide Notes"
                            : "Fix Prompt + Note"}
                        </button>
                        <button
                          className="btn btn-small"
                          onClick={() => {
                            setPatchModal({ group, deal });
                            setPatchInput("");
                          }}
                        >
                          Paste Patch JSON
                        </button>
                      </div>

                      {expandedNotes[noteKey] && (
                        <div className="deal-note-box">
                          <textarea
                            className="deal-note-input"
                            value={dealNotes[noteKey] || ""}
                            onChange={(e) =>
                              updateSession({
                                dealNotes: {
                                  ...dealNotes,
                                  [noteKey]: e.target.value,
                                },
                              })
                            }
                            placeholder="Example: make this more customer-facing, use a stronger CTA, don't say member offer"
                            spellCheck={false}
                          />
                          <div className="deal-note-actions">
                            <button
                              className="btn btn-small btn-accent"
                              onClick={() =>
                                handleSingleDealPrompt(
                                  group,
                                  deal,
                                  dealNotes[noteKey] || "",
                                )
                              }
                            >
                              Copy Prompt with Note
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="copy-step">
      {validationError && (
        <Modal
          title={validationError.title}
          onConfirm={() => setValidationError(null)}
          confirmText="OK, I'll Fix It"
        >
          <p>{validationError.msg}</p>
          {validationError.details && (
            <ul className="error-list">
              {validationError.details.map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
          )}
        </Modal>
      )}

      {validationWarnings && (
        <div className="modal-overlay">
          <div className="modal modal-wide">
            <h3>⚠ Review Before Proceeding</h3>
            <div className="modal-body">
              <p className="gate-intro">
                The AI output has {validationWarnings.length} item
                {validationWarnings.length > 1 ? "s" : ""} that need your
                attention. Review each one, then decide whether to proceed or go
                back and fix the JSON.
              </p>

              <div className="gate-warnings">
                {validationWarnings.map((item, i) => (
                  <div key={i} className="gate-item">
                    <div className="gate-item-header">
                      <strong>{item.vendorName}</strong> — Deal {item.dealIdx}
                    </div>
                    {item.headline && (
                      <div className="gate-headline">
                        Headline: {item.headline}
                      </div>
                    )}
                    {item.description && (
                      <div className="gate-desc">
                        Description: {item.description}
                      </div>
                    )}
                    <div className="gate-source">Source: {item.dealText}</div>
                    {item.warnings.map((w, wi) => (
                      <div
                        key={wi}
                        className={`gate-warning gate-warning-${w.severity}`}
                      >
                        {w.severity === "error" ? "🚨" : "⚠️"} {w.msg}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
            <div className="modal-actions">
              <button className="btn" onClick={handleCancelGate}>
                ← Go Back & Fix JSON
              </button>
              <button
                className="btn btn-accent"
                onClick={handleProceedPastGate}
              >
                I've Reviewed — Proceed Anyway →
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="copy-toolbar">
        <div className="copy-toolbar-left">
          <button className="btn" onClick={() => setShowQuickAdd(true)}>
            + Quick Add Deal
          </button>
          <button className="btn" onClick={() => setShowStyleEditor(true)}>
            Edit House Style
          </button>
        </div>
      </div>

      {showStyleEditor && (
        <Modal
          title="House Style"
          onConfirm={() => setShowStyleEditor(false)}
          onCancel={() => setShowStyleEditor(false)}
          confirmText="Done"
          wide
        >
          <textarea
            value={houseStyle}
            onChange={(e) => updateSession({ houseStyle: e.target.value })}
            className="modal-textarea"
            spellCheck={false}
          />
        </Modal>
      )}

      {showQuickAdd && (
        <Modal
          title="Quick Add Deal"
          onConfirm={handleQuickAdd}
          onCancel={() => setShowQuickAdd(false)}
          confirmText="Add Deal"
        >
          <div className="mini-form">
            <label className="mini-form-label">Vendor</label>
            <input
              className="mini-input"
              value={quickAddVendor}
              onChange={(e) => setQuickAddVendor(e.target.value)}
            />
            <label className="mini-form-label">Deal text</label>
            <textarea
              className="modal-textarea modal-textarea-short"
              value={quickAddDealText}
              onChange={(e) => setQuickAddDealText(e.target.value)}
              spellCheck={false}
            />
            <label className="toggle">
              <input
                type="checkbox"
                checked={quickAddExclusive}
                onChange={(e) => setQuickAddExclusive(e.target.checked)}
              />
              Mark as exclusive
            </label>
          </div>
        </Modal>
      )}

      <div className="two-col">
        <div className="panel">
          <div className="panel-header">
            <div className="badge-circle">1</div>
            <h2>1. Get copy for your action list</h2>
          </div>
          <div className="panel-body">
            <textarea
              value={rawInput}
              onChange={(e) => updateSession({ rawInput: e.target.value })}
              placeholder="v Vendor Name&#10;d Deal text..."
              spellCheck={false}
            />
          </div>
          <div className="panel-footer">
            <button
              className="btn btn-accent full-width"
              onClick={handleGeneratePrompt}
            >
              Copy Batch Prompt
            </button>
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <div className="badge-circle">2</div>
            <h2>2. Check the AI response</h2>
          </div>
          <div className="panel-body">
            <textarea
              value={jsonInput}
              onChange={(e) => updateSession({ jsonInput: e.target.value })}
              placeholder="Paste JSON here..."
              spellCheck={false}
            />
          </div>
          <div className="panel-footer">
            <button
              className="btn btn-success full-width"
              onClick={handleValidate}
              disabled={!jsonInput}
            >
              Check copy & open publishing queue
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Modal({
  title,
  children,
  onConfirm,
  onCancel,
  confirmText = "Confirm",
  wide = false,
}: {
  title?: any;
  children?: any;
  onConfirm?: () => void;
  onCancel?: () => void;
  confirmText?: string;
  wide?: boolean;
}) {
  return (
    <div className="modal-overlay">
      <div className={`modal ${wide ? "modal-wide" : ""}`}>
        <h3>{title}</h3>
        <div className="modal-body">{children}</div>
        <div className="modal-actions">
          {onCancel && (
            <button className="btn" onClick={onCancel}>
              Cancel
            </button>
          )}
          {onConfirm && (
            <button className="btn btn-accent" onClick={onConfirm}>
              {confirmText}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
