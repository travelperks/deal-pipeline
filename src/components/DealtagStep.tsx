import React, { useMemo, useRef, useCallback } from 'react';
import { filterAcceptedTaggedText, transform } from '../logic/dealtag.js';

function parseLines(output) {
  if (!output) return [];
  return output.split('\n').map((line) => {
    const tag = line.split('\t', 1)[0];
    return { tag, text: line.slice(tag.length + 1) };
  });
}

/**
 * Presents raw-email tagging as a reviewable two-pane operation. It delegates
 * classification to `transform`, keeps input and output scrolling aligned, and
 * hands only the operator-reviewed tagged text to the Dedupe step.
 */
export default function DealtagStep({ session, onSessionChange, onComplete, showToast }) {
  const leftRef = useRef(null);
  const rightRef = useRef(null);
  const syncing = useRef(false);

  const { input, output, stats, includeX } = session;
  const lines = useMemo(() => parseLines(output), [output]);

  const updateSession = useCallback((patch) => {
    onSessionChange((prev) => (
      typeof patch === 'function' ? patch(prev) : { ...prev, ...patch }
    ));
  }, [onSessionChange]);

  const run = useCallback(() => {
    const result = transform(input, { includeUnknowns: includeX });
    updateSession({
      output: result.text,
      stats: result.stats,
    });
  }, [includeX, input, updateSession]);

  const copy = useCallback(() => {
    navigator.clipboard.writeText(output).then(() => showToast('Output copied', 'success')).catch(() => showToast('Could not copy. Please try again.', 'error'));
  }, [output, showToast]);

  const sendToDedupe = useCallback(() => {
    if (!output) {
      showToast('Run transform first', 'error');
      return;
    }
    const acceptedOutput = filterAcceptedTaggedText(output);
    if (!acceptedOutput) {
      showToast('No accepted deals to send', 'error');
      return;
    }
    onComplete(acceptedOutput);
  }, [onComplete, output, showToast]);

  const syncScroll = useCallback((from, to) => {
    if (syncing.current) return;
    syncing.current = true;
    const maxFrom = Math.max(1, from.scrollHeight - from.clientHeight);
    const ratio = from.scrollTop / maxFrom;
    const maxTo = Math.max(1, to.scrollHeight - to.clientHeight);
    to.scrollTop = ratio * maxTo;
    syncing.current = false;
  }, []);

  return (
    <div className="dealtag-step">
      <div className="two-col">
        <div className="panel">
          <div className="panel-header">
            <h2>Weekly promo email</h2>
            <span className="pill">{input.trim() ? input.split('\n').length : 0} lines</span>
          </div>
          <div
            className="panel-body"
            ref={leftRef}
            onScroll={() => rightRef.current && syncScroll(leftRef.current, rightRef.current)}
          >
            <textarea
              value={input}
              onChange={(e) => updateSession({ input: e.target.value, output: '', stats: null })}
              placeholder="Paste your full promo list here..."
              spellCheck={false}
            />
          </div>
          <div className="panel-footer">
            <label className="toggle">
              <input
                type="checkbox"
                checked={includeX}
                onChange={(e) => updateSession({ includeX: e.target.checked, output: '', stats: null })}
              />
              Include unknowns (X)
            </label>
            <button className="btn btn-accent" onClick={run} disabled={!input.trim()}>Tag deals</button>
            <button className="btn" onClick={copy} disabled={!output}>Copy Output</button>
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <h2>Tagged deals</h2>
            {stats && (
              <div className="stat-pills">
                <span className="pill pill-ok">{stats.vendors} suppliers</span>
                <span className="pill">{stats.deals} deals</span>
                <span className="pill pill-warn">{stats.excl} exclusive</span>
                <span className="pill pill-bad">{stats.unknownSuppliers} unknown</span>
              </div>
            )}
          </div>
          <div
            className="panel-body scrollpane"
            ref={rightRef}
            onScroll={() => leftRef.current && syncScroll(rightRef.current, leftRef.current)}
          >
            <div className="output-lines">
              {lines.map((line, index) => (
                <div key={index} className="output-line">
                  <span className={`tag tag-${line.tag}`}>{line.tag}</span>
                  <span className="tag-text">{line.text}</span>
                </div>
              ))}
              {lines.length === 0 && <div className="empty-state">Tag the email to review your deals here</div>}
            </div>
          </div>
          <div className="panel-footer">
            <button className="btn btn-forward" onClick={sendToDedupe} disabled={!output}>
              Continue to Compare →
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
