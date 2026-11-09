import React, { useCallback, useEffect, useRef, useState } from 'react';
import DealtagStep from './components/DealtagStep';
import DedupeStep from './components/DedupeStep';
import CopywritingStep from './components/CopywritingStep';
import { DEFAULT_HOUSE_STYLE } from './logic/copywriting.js';
import { parseRawEmail } from './logic/dealCoreClient';

const STEPS = [
  { key: 'tag', label: 'Tag', desc: 'Prepare the source', intro: 'Turn the weekly source into clean, structured deal lines.' },
  { key: 'dedupe', label: 'Compare', desc: 'Find the work', intro: 'Review the weakest matches first. Keep only new offers and changes.' },
  { key: 'copy', label: 'Publish', desc: 'Review & copy', intro: 'Check the copy, move each field to the website, and track what’s done.' },
];

const STORAGE_KEY = 'deal-pipeline-session';

function createDefaultSession() {
  return {
    activeStep: 'tag',
    tag: {
      input: '',
      output: '',
      stats: null,
      includeX: true,
    },
    dedupe: {
      hqText: '',
      websiteRows: [],
      lastRun: null,
      threshold: 0,
      supplierFilter: '',
      viewFilter: 'review',
      restrictToday: false,
      rejectedHQIds: [],
      decisions: {},
    },
    copy: {
      view: 'input',
      rawInput: '',
      jsonInput: '',
      finalGroups: [],
      houseStyle: DEFAULT_HOUSE_STYLE,
      dealNotes: {},
      sourceActions: [],
    },
  };
}

function loadSession() {
  const fallback = createDefaultSession();

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return {
      ...fallback,
      ...parsed,
      tag: { ...fallback.tag, ...(parsed.tag || {}) },
      dedupe: { ...fallback.dedupe, ...(parsed.dedupe || {}) },
      copy: { ...fallback.copy, ...(parsed.copy || {}) },
    };
  } catch {
    return fallback;
  }
}

/**
 * Owns the three-step workflow shell and the durable browser session shared by
 * Tag, Dedupe, and Copy. Step handoffs deliberately reset downstream derived
 * state, while the global reset clears persisted work and remounts every step.
 */
export default function App() {
  const [session, setSession] = useState(loadSession);
  const [notify, setNotify] = useState(null);
  const [showGlobalReset, setShowGlobalReset] = useState(false);
  const [resetVersion, setResetVersion] = useState(0);
  const toastTimerRef = useRef(null);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    } catch {}
  }, [session]);

  useEffect(
    () => () => {
      if (toastTimerRef.current) {
        clearTimeout(toastTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;

    parseRawEmail('Carnival\nDeal line').then((result) => {
      if (!cancelled && !result.ok) {
        console.warn('deal-core smoke parse failed', result);
      }
    }).catch((error) => {
      if (!cancelled) {
        console.warn('deal-core smoke parse failed', error);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const setStep = useCallback((step) => {
    setSession((prev) => ({ ...prev, activeStep: step }));
  }, []);

  const updateStepState = useCallback((stepKey, updater) => {
    setSession((prev) => {
      const current = prev[stepKey];
      const next =
        typeof updater === 'function' ? updater(current) : { ...current, ...updater };
      return { ...prev, [stepKey]: next };
    });
  }, []);

  const updateDedupeState = useCallback((updater) => {
    setSession((prev) => {
      const current = prev.dedupe;
      const next = typeof updater === 'function'
        ? updater(current)
        : { ...current, ...updater };
      const outputChanged = current.hqText !== next.hqText
        || current.lastRun !== next.lastRun
        || current.threshold !== next.threshold
        || current.restrictToday !== next.restrictToday
        || current.rejectedHQIds !== next.rejectedHQIds
        || current.decisions !== next.decisions;

      return {
        ...prev,
        dedupe: next,
        copy: outputChanged
          ? { ...createDefaultSession().copy, houseStyle: prev.copy.houseStyle }
          : prev.copy,
      };
    });
  }, []);

  const showToast = useCallback((msg, type = 'info') => {
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
    }
    setNotify({ msg, type });
    toastTimerRef.current = setTimeout(() => {
      setNotify(null);
      toastTimerRef.current = null;
    }, 4000);
  }, []);

  const handleTagComplete = useCallback((text) => {
    setSession((prev) => ({
      ...prev,
      activeStep: 'dedupe',
      dedupe: {
        ...prev.dedupe,
        hqText: text,
        lastRun: null,
        rejectedHQIds: [],
      decisions: {},
      },
      copy: {
        ...createDefaultSession().copy,
        houseStyle: prev.copy.houseStyle,
      },
    }));
    showToast('Tagged text loaded into Dedupe', 'success');
  }, [showToast]);

  const handleDedupeComplete = useCallback((text, sourceActions = []) => {
    setSession((prev) => ({
      ...prev,
      activeStep: 'copy',
      copy: {
        ...createDefaultSession().copy,
        rawInput: text,
        sourceActions,
        houseStyle: prev.copy.houseStyle,
      },
    }));
    showToast('New and changed deals loaded into Copywriting', 'success');
  }, [showToast]);

  const handleGlobalReset = useCallback(() => {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {}
    setSession(createDefaultSession());
    setNotify(null);
    setShowGlobalReset(false);
    setResetVersion((version) => version + 1);
  }, []);

  const stepStates = {
    tag: session.tag.output?.trim() ? 'complete' : 'current',
    dedupe: session.dedupe.lastRun ? 'complete' : session.dedupe.hqText?.trim() ? 'ready' : 'waiting',
    copy: session.copy.finalGroups?.length && session.copy.finalGroups.every(group => group.deals.every(deal => deal.checked)) ? 'complete' : session.copy.rawInput?.trim() ? 'ready' : 'waiting',
  };
  const activeStepIndex = STEPS.findIndex((step) => step.key === session.activeStep);
  const activeStep = STEPS[activeStepIndex] || STEPS[0];
  const activeState = stepStates[activeStep.key];

  return (
    <div className="app">
      <header className="app-header">
        <a className="app-brand" href="/" aria-label="Deal Pipeline home">
          <span className="brand-mark" aria-hidden="true">DP</span>
          <span>
            <span className="brand-eyebrow">Weekly deal workspace</span>
            <span className="app-title">Deal Pipeline</span>
          </span>
        </a>
        <nav className="step-nav" aria-label="Deal workflow">
          {STEPS.map((step, index) => (
            <button
              key={step.key}
              className={`step-tab ${session.activeStep === step.key ? 'active' : ''} state-${stepStates[step.key]}`}
              onClick={() => setStep(step.key)}
              aria-current={session.activeStep === step.key ? 'step' : undefined}
            >
              <span className="step-number" aria-hidden="true">{index + 1}</span>
              <span className="step-copy">
                <span className="step-label">{step.label}</span>
                <span className="step-desc">{step.desc}</span>
              </span>
              <span className="step-state" aria-label={stepStates[step.key]}>
                {stepStates[step.key] === 'complete' ? '✓' : stepStates[step.key] === 'ready' ? '•' : ''}
              </span>
            </button>
          ))}
        </nav>
        <button className="btn btn-reset-global" onClick={() => setShowGlobalReset(true)} title="Clear this saved session">
          Start over
        </button>
      </header>

      {showGlobalReset && (
        <div className="modal-overlay">
          <div className="modal">
            <h3>Reset Everything?</h3>
            <div className="modal-body">
              <p>This will clear ALL data across all three steps. You&apos;ll start completely fresh.</p>
            </div>
            <div className="modal-actions">
              <button className="btn" onClick={() => setShowGlobalReset(false)}>Cancel</button>
              <button className="btn btn-danger" onClick={handleGlobalReset}>Yes, Reset Everything</button>
            </div>
          </div>
        </div>
      )}

      {notify && (
        <div className={`toast toast-${notify.type}`}>
          {notify.msg}
          <button onClick={() => setNotify(null)}>x</button>
        </div>
      )}

      <main className="app-main">
        <section className="workspace-heading" aria-labelledby="current-step-title">
          <div>
            <span className="workspace-eyebrow">Step {activeStepIndex + 1} of {STEPS.length}</span>
            <h2 id="current-step-title">{activeStep.label}</h2>
            <p>{activeStep.intro}</p>
          </div>
          <span className={`status-chip status-${activeState}`}>
            {activeState === 'complete' ? 'Complete' : activeState === 'ready' ? 'Ready to continue' : 'Current step'}
          </span>
        </section>
        <div className="workspace-surface">
        <div className="step-stage" style={{ display: session.activeStep === 'tag' ? 'block' : 'none' }}>
          <DealtagStep
            key={`tag-${resetVersion}`}
            session={session.tag}
            onSessionChange={(updater) => updateStepState('tag', updater)}
            onComplete={handleTagComplete}
            showToast={showToast}
          />
        </div>
        <div className="step-stage" style={{ display: session.activeStep === 'dedupe' ? 'block' : 'none' }}>
          <DedupeStep
            key={`dedupe-${resetVersion}`}
            session={session.dedupe}
            onSessionChange={updateDedupeState}
            onComplete={handleDedupeComplete}
            showToast={showToast}
          />
        </div>
        <div className="step-stage" style={{ display: session.activeStep === 'copy' ? 'block' : 'none' }}>
          <CopywritingStep
            key={`copy-${resetVersion}`}
            session={session.copy}
            onSessionChange={(updater) => updateStepState('copy', updater)}
            showToast={showToast}
          />
        </div>
        </div>
      </main>
    </div>
  );
}
