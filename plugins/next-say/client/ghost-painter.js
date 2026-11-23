/**
 * Composer overlay (`GhostPainter` / `SuggestionRow`) and manual dock button
 * (`ManualControl`) for dsh-plugin-next-say.
 *
 * Inlined into `lib/client.js` by `tools/build-client.mjs`. Pure ASCII only.
 */

function ManualControl(props) {
  const sessionId = props.sessionId;
  const t = typeof props.t === 'function' ? props.t : (key) => zh[key] || key;
  const [, repaint] = React.useState(0);
  const life = React.useMemo(() => ({ active: true }), [sessionId]);
  React.useEffect(() => {
    life.active = true;
    const stop = manualControls.subscribe((id) => { if (id === sessionId) repaint((value) => value + 1); });
    repaint((value) => value + 1);
    return () => { life.active = false; stop(); };
  }, [sessionId]);
  const entry = manualControls.entries.get(sessionId);
  if (!entry || !entry.visible) return null;
  const onClick = async (event) => {
    const button = event.currentTarget;
    if (!life.active || manualControls.entries.get(sessionId)?.owner !== entry.owner || !entry.ready) return;
    const ok = await entry.run();
    if (ok && life.active && manualControls.entries.get(sessionId)?.owner === entry.owner &&
        typeof document !== 'undefined' && document.activeElement === button && button.isConnected !== false) {
      try { props.inputActions?.focus?.(); } catch { /* The host may already be closing its input context. */ }
    }
  };
  return h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 6 } },
    h('button', {
      type: 'button', disabled: !entry.ready, 'aria-busy': entry.busy,
      style: { font: 'inherit', fontSize: 12, padding: '4px 10px', borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-primary, #8884)', background: 'transparent',
        color: 'var(--dsw-alias-label-primary, inherit)', opacity: entry.ready ? 1 : 0.6,
        cursor: entry.ready ? 'pointer' : 'default' },
      onMouseDown: (event) => event.preventDefault(), onClick,
    }, t(entry.hasSuggestion ? 'reroll' : 'manualPredict')),
    h('span', { role: 'status', 'aria-live': 'polite', style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary, #6b7280)' } },
      entry.busy ? t('thinking') : entry.message ? t(entry.message) : t('manualHint')));
}

/** Guard wrapper so missing slot props never throw inside hook calls. */
function SuggestionRow(props) {
  const missing = ['useInput', 'useSession', 'inputActions'].filter(
    (name) => props[name] === undefined || props[name] === null,
  );
  if (missing.length > 0) {
    return null;
  }
  return h(GhostPainter, props);
}

const MANUAL_REASON_KEYS = Object.freeze({
  __proto__: null,
  'no-history': 'noHistory',
  'no-route': 'manualNoRoute',
  timeout: 'timeout',
  empty: 'manualNoResult',
  truncated: 'manualNoResult',
  duplicate: 'manualNoResult',
  'repeats-draft': 'manualNoResult',
  paused: 'manualPaused',
  disabled: 'manualDisabled',
  budget: 'manualBudget',
});

function GhostPainter(props) {
  const sessionId = props.sessionId;
  const useInput = props.useInput;
  const useSession = props.useSession;
  const inputActions = props.inputActions;

  const draft = useInput((state) => (state && typeof state.draft === 'string' ? state.draft : ''));
  const phase = useInput((state) => (state ? state.phase : undefined));
  const running = useSession((session) => Boolean(session && session.running));

  const [settings, setSettings] = React.useState(settingsStore.value);
  const [suggestion, setSuggestion] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [manualMessage, setManualMessage] = React.useState('');
  const [budgetExhausted, setBudgetExhausted] = React.useState(false);

  const dismissed = React.useRef('');
  const accepted = React.useRef('');
  const historyRef = React.useRef([]);
  const recallRef = React.useRef(null);
  const draftRef = React.useRef(draft);
  draftRef.current = draft;

  const [historyEpoch, setHistoryEpoch] = React.useState(0);
  const [suppressionEpoch, setSuppressionEpoch] = React.useState(0);
  const alive = React.useRef(true);
  const inFlight = React.useRef(null);
  const scope = React.useRef({ sessionId, historyController: null });
  const suggestionSession = React.useRef(sessionId);
  const lastPoolFetch = React.useRef(0);
  const triedOnMount = React.useRef(false);
  const settledTurn = React.useRef(null);
  if (scope.current.sessionId !== sessionId) {
    scope.current = { sessionId };
    historyRef.current = [];
    dismissed.current = '';
    accepted.current = '';
    recallRef.current = null;
    lastPoolFetch.current = 0;
    triedOnMount.current = false;
    settledTurn.current = null;
  }
  const currentScope = scope.current;

  React.useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (inFlight.current !== null) {
        try {
          inFlight.current.abort();
        } catch {
          // Aborting a settled request is a no-op.
        }
        inFlight.current = null;
      }
    };
  }, []);

  React.useEffect(() => settingsStore.subscribe(() => setSettings(settingsStore.value)), []);
  React.useEffect(() => {
    if (settingsStore.value === null) void loadSettings();
  }, []);

  // Re-allow auto predictions when budget setting changes or a new turn runs.
  React.useEffect(() => {
    setBudgetExhausted(false);
    settledTurn.current = null;
  }, [sessionId, settings && settings.dailyCallBudget]);

  // Clear per-session state and refresh history whenever the session changes.
  React.useEffect(() => {
    dismissed.current = '';
    accepted.current = '';
    setSuggestion('');
    setManualMessage('');
    setBusy(false);
    const controller = new AbortController();
    currentScope.historyController = controller;
    if (sessionId) void historyCache.refresh(sessionId, controller.signal).then((items) => {
      if (!alive.current || controller.signal.aborted || scope.current !== currentScope) return;
      historyRef.current = items;
      setHistoryEpoch((value) => value + 1);
    });
    return () => {
      controller.abort();
      manualControls.remove(sessionId, currentScope);
      if (inFlight.current !== null) {
        inFlight.current.abort();
        inFlight.current = null;
      }
    };
  }, [sessionId]);

  const enabled = settings !== null && settings.enabled === true;
  const paused = settings !== null && isPaused(settings);
  const blankDraft = draft.trim() === '';
  const inputReady = phase === 'plain';
  const live = React.useRef(null);
  const [pauseEpoch, setPauseEpoch] = React.useState(0);
  live.current = { enabled, paused, inputReady, running, blankDraft };

  React.useEffect(() => {
    if (!paused) return undefined;
    const wait = Math.min(2147483647, Math.max(1, Number(settings.pausedUntil) - Date.now()));
    const timer = setTimeout(() => setPauseEpoch((value) => value + 1), wait);
    return () => clearTimeout(timer);
  }, [paused, settings && settings.pausedUntil, pauseEpoch]);

  React.useEffect(() => {
    if (enabled && !paused && !running && inputReady) return;
    if (inFlight.current !== null) {
      inFlight.current.abort();
      inFlight.current = null;
      setBusy(false);
    }
  }, [enabled, paused, running, inputReady]);

  /* ------------------------------------------------- local completion */

  const local = React.useMemo(() => {
    if (!enabled || paused || !inputReady || settings === null || settings.historyEnabled !== true) return null;
    if (blankDraft || recallRef.current?.text === draft) return null;
    if (`${draft}\u0000local` === dismissed.current) return null;
    if (draft === accepted.current) return null;
    try {
      return historyCompletion(historyRef.current, draft, {
        minChars: settings.historyMinChars,
        maxEntries: 200,
        maxExtraChars: 400,
      });
    } catch {
      return null;
    }
  }, [enabled, settings, blankDraft, draft, historyEpoch, sessionId, suppressionEpoch, paused, inputReady]);

  /* -------------------------------------------- history pool lifecycle */

  useHistoryPool({
    enabled,
    paused,
    settings,
    blankDraft,
    historyEpoch,
    sessionId,
    historyRef,
    lastPoolFetch,
    alive,
    scope,
    currentScope,
    setHistoryEpoch,
  });

  /* ------------------------------------------- model prediction on turn */

  const predict = React.useCallback(async (options) => {
    const manual = options && options.manual === true;
    if (!alive.current || scope.current !== currentScope) return;
    const state = live.current;
    if (!state.enabled || state.paused || !state.inputReady || state.running || !state.blankDraft) return;
    if (sessionId === undefined || sessionId === null || sessionId === '') return;
    if (inFlight.current !== null) return false;
    const controller = new AbortController();
    inFlight.current = controller;
    setBusy(true);
    if (manual) setManualMessage('');
    const budget = Math.max(2000, Math.min(60000, Number(settingsStore.value?.timeoutMs) || 12000)) + 10000;
    try {
      const body = await postJsonBounded(
        '/predict',
        {
          sessionId,
          manual,
          ...(typeof (options && options.turn) === 'number' ? { turn: options.turn } : {}),
          avoid: options && options.avoid ? options.avoid : '',
          forceDifferent: Boolean(options && options.forceDifferent),
          draft: draftRef.current,
        },
        controller.signal,
        budget,
        () => Object.assign(new Error('prediction response timed out'), { code: 'client-timeout' }),
      );
      if (!alive.current || controller.signal.aborted || scope.current !== currentScope || inFlight.current !== controller) return false;
      suggestionSession.current = sessionId;
      if (body && body.ok === true && typeof body.suggestion === 'string' && body.suggestion !== '') {
        setBudgetExhausted(false);
        const trimmedDraft = draftRef.current.trim();
        const repeatsDraft = trimmedDraft !== '' && body.suggestion.trim() === trimmedDraft;
        if (repeatsDraft || body.suggestion === dismissed.current || body.suggestion === accepted.current) {
          if (manual) setManualMessage('manualNoResult');
          else setSuggestion('');
          return false;
        }
        setSuggestion(body.suggestion);
        if (manual) setManualMessage('manualReady');
        const historySignal = currentScope.historyController.signal;
        void historyCache.refresh(sessionId, historySignal).then((items) => {
          if (!alive.current || historySignal.aborted || controller.signal.aborted || scope.current !== currentScope) return;
          historyRef.current = items;
          setHistoryEpoch((value) => value + 1);
        });
        return true;
      }
      if (body && body.reason === 'budget') {
        if (typeof (options && options.turn) === 'number') {
          settledTurn.current = Math.max(options.turn, settledTurn.current ?? -Infinity);
        }
        setBudgetExhausted(true);
      }
      if (manual) {
        const key = MANUAL_REASON_KEYS[body && body.reason] || 'failed';
        setManualMessage(key);
      } else {
        setSuggestion('');
      }
      return false;
    } catch (error) {
      if (!alive.current || scope.current !== currentScope || inFlight.current !== controller) return false;
      if (error && error.code === 'client-timeout') {
        if (manual) setManualMessage('timeout');
      } else if (controller.signal.aborted) {
        if (manual && controller.signal.reason?.code === 'client-timeout') setManualMessage('timeout');
      } else if (manual) {
        setManualMessage('failed');
      }
      return false;
    } finally {
      if (inFlight.current === controller) {
        inFlight.current = null;
        if (alive.current && scope.current === currentScope) setBusy(false);
      }
    }
  }, [sessionId]);

  const predictRef = React.useRef(predict);
  predictRef.current = predict;

  useTurnPoller({
    enabled,
    paused,
    sessionId,
    settings,
    running,
    blankDraft,
    suggestion,
    busy,
    inputReady,
    budgetExhausted,
    triedOnMount,
    settledTurn,
    alive,
    scope,
    currentScope,
    predictRef,
  });

  React.useEffect(() => {
    if (typeof sessionId !== 'string' || sessionId === '') return;
    const hasSuggestion = suggestionSession.current === sessionId && suggestion !== '' && suggestion !== dismissed.current;
    const message = paused ? 'manualPaused' : !inputReady ? 'manualInputBusy' : running ? 'manualRunning'
      : !blankDraft ? 'manualDraft' : manualMessage === 'manualReady' && !hasSuggestion ? '' : manualMessage;
    manualControls.publish(sessionId, currentScope, {
      visible: enabled && settings !== null && settings.mode === 'manual',
      ready: enabled && !paused && inputReady && !running && blankDraft && !busy,
      busy, hasSuggestion, message,
      run: () => predict({ manual: true, avoid: suggestion, forceDifferent: hasSuggestion }),
    });
  }, [sessionId, settings, enabled, paused, inputReady, running, blankDraft, busy, manualMessage, suggestion, predict]);

  /* ------------------------------------------------------------ accept */

  const accept = React.useCallback((text, partial) => {
    if (text === '' || !inputActions || !live.current.enabled || live.current.paused || !live.current.inputReady) return false;
    try {
      const span = inputActions.captureInsertion();
      if (!inputActions.insertText(text, span)) return false;
      if (partial === true) return true;
      accepted.current = draftRef.current + text;
      dismissed.current = '';
      setSuppressionEpoch((value) => value + 1);
      setSuggestion('');
      return true;
    } catch {
      return false;
    }
  }, [inputActions]);

  const dismiss = React.useCallback(() => {
    setSuppressionEpoch((value) => value + 1);
    dismissed.current = suggestionSession.current === sessionId && !running && suggestion !== '' && (blankDraft || suggestionRemainder(suggestion, draft) !== null)
      ? suggestion
      : `${draft}\u0000local`;
    setSuggestion('');
  }, [suggestion, draft, sessionId, blankDraft, running]);

  /* ------------------------------------------------------------ render */

  // No early return may appear above this point (stable React hook count).
  const recalling = !blankDraft && recallRef.current?.text === draft;
  const modelLive = suggestion !== '' && suggestionSession.current === sessionId && suggestion !== dismissed.current && !running && !recalling;
  const modelFollows = !modelLive || blankDraft ? null : suggestionRemainder(suggestion, draft);
  const modelText = !modelLive
    ? ''
    : (blankDraft ? suggestion : (modelFollows === null ? '' : modelFollows));
  const localSuffix = modelText !== '' || local === null ? '' : local.suffix;

  const ghostText = modelText !== '' ? modelText : localSuffix;
  const ghostPrefix = ghostText !== '' && !blankDraft ? draft : '';

  const acceptSuggested = React.useCallback((wordOnly) => {
    const offered = modelText !== '' ? modelText : localSuffix;
    if (offered === '') return false;
    const count = wordOnly === true ? nextWordLength(offered) : offered.length;
    const piece = count >= offered.length ? offered : offered.slice(0, count);
    return accept(piece, piece.length < offered.length);
  }, [accept, modelText, localSuffix]);

  useComposerKeys({
    enabled,
    paused,
    inputReady,
    sessionId,
    modelText,
    local,
    draft,
    inputActions,
    acceptSuggested,
    dismiss,
    live,
    scope,
    currentScope,
    historyRef,
    recallRef,
  });

  // Typing hides a prediction; only a running turn discards it.
  React.useEffect(() => {
    if (suggestion === '') return;
    if (!running) return;
    setSuggestion('');
  }, [suggestion, running]);

  // Paint ghost text over the active composer editor.
  React.useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    if (!enabled || paused) {
      clearGhost(document, sessionId);
      return undefined;
    }
    if (!inputReady) {
      paintGhost(document, sessionId, '');
      return undefined;
    }
    if (ghostText === '') {
      paintGhost(document, sessionId, '');
      return undefined;
    }
    paintGhost(document, sessionId, ghostText, { prefix: ghostPrefix });
    return undefined;
  }, [enabled, paused, inputReady, sessionId, ghostText, ghostPrefix]);

  // Leaving this session or unmounting clears its ghost layer cleanly.
  React.useEffect(() => () => {
    if (typeof document !== 'undefined') clearGhost(document, sessionId);
  }, [sessionId]);

  return null;
}
