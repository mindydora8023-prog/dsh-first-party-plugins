/**
 * Custom React hooks for next-say's composer overlay.
 *
 * Isolates:
 *   - `useHistoryPool`: throttled retry when the initial session pool is empty,
 *     keyed on `blankDraft` (never raw `draft`) so typing never aborts `/history`.
 *   - `useTurnPoller`: one-shot mount attempt + single-flight `/turn` polling
 *     that stops cleanly on `enabled === false`, `paused === true`,
 *     `mode !== 'auto'`, or daily budget exhaustion.
 *   - `useComposerKeys`: ONE stable document `keydown` listener reading live
 *     state from a ref, handling both ghost acceptance/dismissal and history
 *     recall without tearing down listeners on every keystroke.
 *
 * Inlined into `lib/client.js` by `tools/build-client.mjs`. Pure ASCII only.
 */

function useHistoryPool({
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
}) {
  // Retry while the user is typing and the pool is still empty, throttled so it
  // cannot become a poll loop. Depends on `blankDraft` (boolean), NOT `draft`,
  // so typing characters does not abort an in-flight `/history` request.
  React.useEffect(() => {
    if (!enabled || paused || settings === null || settings.historyEnabled !== true) return undefined;
    if (blankDraft || historyRef.current.length > 0) return undefined;
    const now = Date.now();
    if (now - lastPoolFetch.current < 4000) return undefined;
    lastPoolFetch.current = now;
    const controller = new AbortController();
    void historyCache.refresh(sessionId, controller.signal).then((items) => {
      if (controller.signal.aborted || !alive.current || scope.current !== currentScope) return;
      historyRef.current = items;
      setHistoryEpoch((value) => value + 1);
    });
    return () => {
      controller.abort();
    };
  }, [enabled, paused, settings, blankDraft, historyEpoch, sessionId]);
}

function useTurnPoller({
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
}) {
  // One attempt per composer mount, before any turn bookkeeping is involved.
  React.useEffect(() => {
    if (!enabled || paused || budgetExhausted) return undefined;
    if (sessionId === undefined || sessionId === null || sessionId === '') return undefined;
    if (settings === null || settings.mode !== 'auto' || !inputReady) return undefined;
    if (running || !blankDraft) return undefined;
    if (suggestion !== '' || busy) return undefined;
    if (triedOnMount.current) return undefined;
    const timer = setTimeout(() => {
      if (!alive.current || scope.current !== currentScope) return;
      triedOnMount.current = true;
      void predictRef.current({ manual: false });
    }, 1200);
    return () => clearTimeout(timer);
  }, [enabled, paused, budgetExhausted, sessionId, settings, running, blankDraft, suggestion, busy, inputReady]);

  // Poll the Host's turn feed rather than agent/status.
  React.useEffect(() => {
    if (!enabled || paused || budgetExhausted) return undefined;
    if (sessionId === undefined || sessionId === null || sessionId === '') return undefined;
    if (settings === null || settings.mode !== 'auto' || !inputReady) return undefined;
    if (running || !blankDraft) return undefined;
    if (suggestion !== '' || busy) return undefined;

    let cancelled = false;
    let timer;
    let checking = false;
    const controller = new AbortController();
    const hidden = () => {
      try { return document.visibilityState === 'hidden'; } catch { return false; }
    };

    const tick = async () => {
      if (cancelled || !alive.current || hidden() || checking) return;
      checking = true;
      let turn = null;
      let predicted = null;
      let stopPolling = false;
      try {
        const body = await getJsonBounded('/turn?sessionId=' + encodeURIComponent(sessionId), controller.signal);
        if (body && body.ok !== false) {
          if (body.enabled === false || body.paused === true || (body.mode !== undefined && body.mode !== 'auto')) {
            stopPolling = true;
          } else {
            turn = body.turn;
            predicted = body.predicted === undefined ? null : body.predicted;
          }
        }
      } catch {
        // A Host that is briefly unreachable is not an error worth showing.
      } finally {
        checking = false;
      }
      if (stopPolling || cancelled || !alive.current || hidden() || scope.current !== currentScope) return;
      const localSettled = settledTurn.current;
      const alreadyDone = (predicted !== null && turn !== null && turn <= predicted)
        || (localSettled !== null && turn !== null && turn <= localSettled);
      if (turn === null || turn === undefined || alreadyDone) {
        timer = setTimeout(tick, 2000);
        return;
      }
      void predictRef.current({ manual: false, turn });
    };

    const onVisibility = () => {
      if (cancelled) return;
      clearTimeout(timer);
      if (!hidden()) timer = setTimeout(tick, 0);
    };
    try { document.addEventListener('visibilitychange', onVisibility); } catch { /* non-DOM host */ }

    if (!hidden()) timer = setTimeout(tick, 900);
    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer);
      try { document.removeEventListener('visibilitychange', onVisibility); } catch { /* ignore */ }
    };
  }, [enabled, paused, budgetExhausted, sessionId, settings, running, blankDraft, suggestion, busy, inputReady]);
}

function useComposerKeys(state) {
  const keyState = React.useRef(state);
  keyState.current = state;

  React.useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const onKeyDown = (event) => {
      if (event.defaultPrevented || event.isComposing) return;
      const s = keyState.current;
      if (!s.enabled || s.paused || !s.inputReady || !s.live.current.inputReady) return;
      if (s.scope.current !== s.currentScope) return;
      if (!inComposer(s.sessionId)) return;

      // 1. Suggestion keys: Tab (full), Ctrl/Cmd+Right (next word), Escape (dismiss).
      if (s.modelText !== '' || s.local !== null) {
        if (event.key === 'Tab' && event.shiftKey !== true && event.ctrlKey !== true && event.metaKey !== true && event.altKey !== true) {
          if (s.acceptSuggested(false)) {
            event.preventDefault();
            event.stopPropagation();
          }
          return;
        }
        if (event.key === 'ArrowRight' && event.altKey !== true && event.shiftKey !== true && (event.ctrlKey === true || event.metaKey === true)) {
          if (s.acceptSuggested(true)) {
            event.preventDefault();
            event.stopPropagation();
          }
          return;
        }
        if (event.key === 'Escape') {
          s.dismiss();
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }

      // 2. History recall: ArrowUp / ArrowDown when no suggestion is visible.
      const inputs = s.inputActions;
      if (!inputs || typeof inputs.setDraft !== 'function') return;
      if (event.altKey === true || event.ctrlKey === true || event.metaKey === true || event.shiftKey === true) return;
      const step = historyRecallStep(s.historyRef.current, s.recallRef.current, s.draft, event.key);
      if (step === null) return;
      if (step.action === 'clear') {
        s.recallRef.current = null;
        inputs.setDraft('');
      } else {
        s.recallRef.current = { index: step.index, text: step.text };
        inputs.setDraft(step.text);
      }
      event.preventDefault();
      event.stopPropagation();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, []);
}
