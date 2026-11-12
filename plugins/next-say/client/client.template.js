/**
 * Browser half of dsh-plugin-next-say.
 *
 * Registers ONE headless entry into `conversation.input.overlay` -- the slot that
 * renders INSIDE the composer card -- plus a page in Settings. The entry draws no
 * element of its own: it paints ghost text over the editor (lib/ghost.js) and
 * keeps the Tab/Escape handling, which goes through the composer's own
 * `insertText` so a concurrent edit can never be overwritten.
 *
 * Built file. Edit `client/client.template.js` and run tools/build-client.py;
 * `lib/locales.js`, `lib/match.js` and `lib/ghost.js` are inlined there so there
 * is exactly one copy of each in the plugin.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-next-say',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;

    /** Locale namespace owned by this plugin. */
    const NS = 'nextSay';

    /** API prefix served by the Host half. */
    const API = '/next-say';

    /*__LOCALES__*/

    /*__MATCH__*/

    /*__GHOST__*/

    /* --------------------------------------------------------------- helpers */

    const DEFAULT_SETTINGS = {
      enabled: true,
      mode: 'auto',
      provider: '',
      model: '',
      maxSuggestionChars: 120,
      contextMessages: 8,
      contextChars: 6000,
      timeoutMs: 12000,
      historyEnabled: true,
      historyMinChars: 2,
      pausedUntil: 0,
    };

    const RANGES = {
      maxSuggestionChars: [20, 400],
      contextMessages: [2, 20],
      contextChars: [1000, 20000],
      timeoutMs: [2000, 60000],
      historyMinChars: [1, 8],
    };

    function isPaused(settings, now) {
      const until = Number(settings && settings.pausedUntil);
      return Number.isFinite(until) && until > (now || Date.now());
    }

    async function getJson(path, signal) {
      const response = await fetch(API + path, {
        credentials: 'same-origin',
        ...(signal === undefined ? {} : { signal }),
      });
      const body = await response.json();
      return body;
    }

    async function postJson(path, payload, signal) {
      const response = await fetch(API + path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        ...(signal === undefined ? {} : { signal }),
      });
      return response.json();
    }

    /**
     * Whether the caret is in the message editor.
     *
     * Tab must never be swallowed while the user is in another field (a search
     * box, a settings input): that would break ordinary focus movement.
     */
    function inComposer() {
      const active = document.activeElement;
      if (active === null || active === undefined) return false;
      if (typeof active.closest === 'function' && active.closest('[data-composer-input="true"]') !== null) return true;
      if (active.isContentEditable === true) return true;
      const tag = String(active.tagName || '').toLowerCase();
      if (tag !== 'textarea' && tag !== 'input') return false;
      return typeof active.closest === 'function' && active.closest('[data-input-scroll]') !== null;
    }

    /** Shared settings snapshot, so the row and the settings page agree. */
    const settingsStore = {
      value: null,
      error: undefined,
      listeners: new Set(),
      set(next) {
        this.value = next;
        for (const listener of this.listeners) {
          try {
            listener();
          } catch {
            // A broken listener must not stop the others from repainting.
          }
        }
      },
      subscribe(listener) {
        this.listeners.add(listener);
        return () => {
          this.listeners.delete(listener);
        };
      },
    };

    async function loadSettings() {
      try {
        const body = await getJson('/settings');
        if (body && body.settings) {
          settingsStore.error = undefined;
          settingsStore.set(body.settings);
          return body.settings;
        }
        throw new Error('settings response carried no settings');
      } catch (error) {
        settingsStore.error = error instanceof Error ? error.message : String(error);
        if (settingsStore.value === null) settingsStore.set({ ...DEFAULT_SETTINGS });
        return undefined;
      }
    }

    async function saveSettings(patch) {
      const body = await postJson('/settings', patch);
      if (body && body.settings) settingsStore.set(body.settings);
      return body;
    }

    /**
     * The user's own messages in this conversation, for local completion.
     *
     * Fetched per session and refreshed after each finished turn; a keystroke
     * never hits the network.
     */
    function createHistoryCache() {
      const entries = new Map();
      return {
        get(sessionId) {
          return entries.get(sessionId);
        },
        set(sessionId, items) {
          entries.set(sessionId, Array.isArray(items) ? items : []);
        },
        async refresh(sessionId) {
          if (!sessionId) return [];
          try {
            const body = await getJson('/history?sessionId=' + encodeURIComponent(sessionId));
            const items = body && Array.isArray(body.items) ? body.items : [];
            entries.set(sessionId, items);
            return items;
          } catch {
            return entries.get(sessionId) || [];
          }
        },
        clear(sessionId) {
          entries.delete(sessionId);
        },
      };
    }

    const historyCache = createHistoryCache();

    /**
     * One suggestion row.
     *
     * Everything it renders comes from a slot prop or the plugin's own API: no
     * other plugin's DOM, stylesheet or component is read, so a host redesign
     * degrades this row instead of breaking it.
     */
    /**
     * Guard wrapper for the slot entry.
     *
     * Hooks must run unconditionally, so the capability check lives here and the
     * hook-using body is a separate component: calling `useInput()` on an
     * undefined prop would throw, and a throwing slot entry is dropped silently
     * (only a console line nobody sees).
     */
    function SuggestionRow(props) {
      const missing = ['useInput', 'useSession', 'inputActions'].filter(
        (name) => props[name] === undefined || props[name] === null,
      );
      if (missing.length > 0) {
        // A missing prop means this slot is not the composer we expect. Returning
        // null keeps the failure contained instead of throwing inside the slot.
        return null;
      }
      return h(GhostPainter, props);
    }


    function GhostPainter(props) {
      const t = typeof props.t === 'function'
        ? props.t
        : (key) => (Object.prototype.hasOwnProperty.call(zh, key) ? zh[key] : key);
      const sessionId = props.sessionId;
      const useInput = props.useInput;
      const useSession = props.useSession;
      const inputActions = props.inputActions;

      // Subscribe to the smallest slices that matter: the draft text and the
      // submit phase.
      const draft = useInput((state) => (state && typeof state.draft === 'string' ? state.draft : ''));
      const phase = useInput((state) => (state ? state.phase : undefined));
      const running = useSession((session) => Boolean(session && session.running));

      const [settings, setSettings] = React.useState(settingsStore.value);
      const [suggestion, setSuggestion] = React.useState('');
      const [source, setSource] = React.useState('');
      const [busy, setBusy] = React.useState(false);

      /** Text the user dismissed or accepted; suppresses re-offering it. */
      const dismissed = React.useRef('');
      const accepted = React.useRef('');
      const historyRef = React.useRef([]);
      /**
       * The live draft, readable from callbacks (predict) without re-creating them
       * on every keystroke.
       *
       * This ref has to be DECLARED and kept in sync: an earlier rewrite dropped
       * the declaration while leaving the two reads in place, so `predict()`
       * threw `ReferenceError: draftRef is not defined` before it ever reached
       * the network. The throw was swallowed by its own try/catch, which is why
       * the request never appeared and nothing was logged.
       */
      const draftRef = React.useRef(draft);
      draftRef.current = draft;
      /**
       * Bumped whenever the history pool changes.
       *
       * `historyRef` is a ref on purpose (it must be readable from callbacks
       * without re-subscribing), but a ref is invisible to `useMemo`. Without a
       * version in the dependency list the completion was computed ONCE against
       * an empty pool -- the first render -- and never again after the fetch
       * landed, so history completion silently never appeared.
       */
      const [historyEpoch, setHistoryEpoch] = React.useState(0);
      const alive = React.useRef(true);
      const inFlight = React.useRef(null);

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

      // A new session is a new conversation: clear everything that belonged to
      // the old one instead of showing its suggestion under a different chat.
      React.useEffect(() => {
        dismissed.current = '';
        accepted.current = '';
        setSuggestion('');
        setSource('');
        if (sessionId) void historyCache.refresh(sessionId).then((items) => {
          if (!alive.current) return;
          historyRef.current = items;
          setHistoryEpoch((value) => value + 1);
        });
      }, [sessionId]);

      const enabled = settings !== null && settings.enabled === true;
      const paused = settings !== null && isPaused(settings);
      const blankDraft = draft.trim() === '';

      /* ------------------------------------------------- local completion */

      // Recomputed on every draft change: a pure function over the cached
      // history, so this is a string scan, not a request.
      const local = React.useMemo(() => {
        if (!enabled || settings === null || settings.historyEnabled !== true) return null;
        if (blankDraft) return null;
        // The draft the user dismissed must not be re-offered -- but only that
        // exact draft. Any further edit produces a new draft and may complete
        // again, which is what makes Escape a per-suggestion decision rather
        // than a per-session kill switch.
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
        // `historyEpoch` is a dependency because the pool arrives asynchronously:
        // a ref alone never invalidates this memo.
      }, [enabled, settings, blankDraft, draft, historyEpoch]);

      /* -------------------------------------------- history pool lifecycle */

      // The pool is fetched once when the session changes, but that single fetch
      // races the composer: an empty answer then leaves completion permanently
      // dead, because nothing else refreshes it. Retry while the user is typing
      // and the pool is still empty, throttled so it cannot become a poll loop.
      const lastPoolFetch = React.useRef(0);
      React.useEffect(() => {
        if (!enabled || paused || settings === null || settings.historyEnabled !== true) return undefined;
        if (blankDraft || historyRef.current.length > 0) return undefined;
        const now = Date.now();
        if (now - lastPoolFetch.current < 4000) return undefined;
        lastPoolFetch.current = now;
        let cancelled = false;
        void historyCache.refresh(sessionId).then((items) => {
          if (cancelled || !alive.current) return;
          historyRef.current = items;
          setHistoryEpoch((value) => value + 1);
        });
        return () => {
          cancelled = true;
        };
      }, [enabled, paused, settings, blankDraft, draft, historyEpoch, sessionId]);

      /* ------------------------------------------- model prediction on turn */

      // One attempt per composer mount, before any turn bookkeeping is involved.
      //
      // The turn feed is a derived signal and has already been wrong twice; this
      // guarantees that an idle, empty composer gets offered a suggestion on load
      // even if the feed says nothing. The Host still refuses to spend a second
      // call for a turn it has already predicted, so this cannot double-bill a
      // turn that was also predicted through the feed.
      const triedOnMount = React.useRef(false);
      React.useEffect(() => {
        if (!enabled || paused || sessionId === undefined || sessionId === null || sessionId === '') return undefined;
        if (settings === null || settings.mode !== 'auto') return undefined;
        if (running || !blankDraft) return undefined;
        if (suggestion !== '' || busy) return undefined;
        if (triedOnMount.current) return undefined;
        triedOnMount.current = true;
        const timer = setTimeout(() => {
          if (alive.current) void predict({ manual: false });
        }, 1200);
        return () => clearTimeout(timer);
        // `predict` is deliberately NOT a dependency: it is declared below this
        // effect, so naming it in the array would read it during render (TDZ) and
        // throw. The callback captured here is the one for this session, which is
        // exactly what an effect that runs once wants.
      }, [enabled, paused, sessionId, settings, running, blankDraft, suggestion, busy]);

      // Poll the Host's turn feed rather than agent/status: status flips once
      // per step, so a tool-calling turn looks like many finished turns.
      React.useEffect(() => {
        if (!enabled || paused || sessionId === undefined || sessionId === null || sessionId === '') return undefined;
        if (settings === null || settings.mode !== 'auto') return undefined;
        if (running) return undefined;
        if (!blankDraft) return undefined;
        if (suggestion !== '' || busy) return undefined;

        let cancelled = false;
        let timer;

        const tick = async () => {
          if (cancelled || !alive.current) return;
          let turn = null;
          let predicted = null;
          try {
            // Read only: the Host marks a turn as spent inside /predict, so a
            // cancelled tick (a re-render while this request was in flight) can no
            // longer consume a turn that was never used.
            const body = await getJson('/turn?sessionId=' + encodeURIComponent(sessionId));
            if (body && body.ok !== false) {
              if (body.enabled === false) return;
              turn = body.turn;
              predicted = body.predicted === undefined ? null : body.predicted;
            }
          } catch {
            // A Host that is briefly unreachable is not an error worth showing.
          }
          if (cancelled || !alive.current) return;
          const alreadyDone = predicted !== null && turn !== null && turn <= predicted;
          if (turn === null || turn === undefined || alreadyDone) {
            timer = setTimeout(tick, 2000);
            return;
          }
          void predict({ manual: false, turn });
        };

        timer = setTimeout(tick, 900);
        return () => {
          cancelled = true;
          clearTimeout(timer);
        };
      }, [enabled, paused, sessionId, settings, running, blankDraft, suggestion, busy]);

      /**
       * Ask the Host for a suggestion.
       *
       * `avoid` carries the current text so "another one" cannot come back with
       * the same sentence dressed differently.
       */
      const predict = React.useCallback(async (options) => {
        const manual = options && options.manual === true;
        if (sessionId === undefined || sessionId === null || sessionId === '') return;
        if (inFlight.current !== null) {
          try {
            inFlight.current.abort();
          } catch {
            // Ignore: the request may have settled already.
          }
        }
        const controller = new AbortController();
        inFlight.current = controller;
        setBusy(true);
        try {
          const body = await postJson('/predict', {
            sessionId,
            manual,
            // The turn this prediction is for, so the Host can claim it before
            // spending a model call. Manual and reroll predictions have no turn.
            ...(typeof (options && options.turn) === 'number' ? { turn: options.turn } : {}),
            avoid: options && options.avoid ? options.avoid : '',
            forceDifferent: Boolean(options && options.forceDifferent),
            // The Host refuses a suggestion that repeats this, so the round trip
            // does not even reach the screen.
            draft: draftRef.current,
          }, controller.signal);
          if (!alive.current || controller.signal.aborted) return;
          if (body && body.ok === true && typeof body.suggestion === 'string' && body.suggestion !== '') {
            // A prediction that merely repeats what is already in the composer is
            // worthless: accepting it would insert the sentence twice. This is
            // not hypothetical -- it was observed on screen, because a prediction
            // describes the user's NEXT message while the box may already hold
            // that very text.
            const trimmedDraft = draftRef.current.trim();
            const repeatsDraft = trimmedDraft !== '' && body.suggestion.trim() === trimmedDraft;
            if (repeatsDraft || body.suggestion === dismissed.current || body.suggestion === accepted.current) {
              setSuggestion('');
              setSource('');
            } else {
              setSuggestion(body.suggestion);
              setSource('model');
            }
            void historyCache.refresh(sessionId).then((items) => {
              if (!alive.current) return;
              historyRef.current = items;
              // A finished turn adds the user's own message to the pool, which
              // is exactly when a new completion becomes possible.
              setHistoryEpoch((value) => value + 1);
            });
          } else {
            setSuggestion('');
            setSource('');
          }
        } catch (error) {
          if (!alive.current) return;
          const name = error instanceof Error ? error.name : '';
          if (name === 'AbortError') return;
        } finally {
          if (inFlight.current === controller) inFlight.current = null;
          if (alive.current) {
            setBusy(false);
          }
        }
      }, [sessionId]);

      /* ------------------------------------------------------------ accept */

      /**
       * Fill the draft through the composer's own action.
       *
       * `captureInsertion()` returns the caret span with the draft revision it
       * was measured at; `insertText` refuses the write when the revision moved,
       * so text typed between reading and writing is never overwritten.
       */
      const accept = React.useCallback((text) => {
        if (text === '' || !inputActions) return false;
        try {
          const span = inputActions.captureInsertion();
          if (!inputActions.insertText(text, span)) return false;
          accepted.current = text;
          dismissed.current = '';
          setSuggestion('');
          setSource('');
          return true;
        } catch {
          return false;
        }
      }, [inputActions]);

      /**
       * Insert exactly what the row is describing.
       *
       * Both call sites (the Tab handler and the Accept button) go through this
       * one function so they cannot drift: a model prediction replaces nothing
       * (it is the whole message) while a completion adds only its remainder ON
       * TOP of the draft the user already typed.
       */
      const acceptSuggested = React.useCallback(() => {
        if (suggestion !== '' && suggestion !== dismissed.current) return accept(suggestion);
        if (local !== null) return accept(local.suffix);
        return false;
      }, [accept, suggestion, local]);

      const dismiss = React.useCallback(() => {
        // Remember WHAT was refused, not just "the draft": a dismissed model
        // suggestion must not come back, but a dismissed completion only covers
        // the exact draft it was offered for -- keep typing and it may offer
        // again. Recording the raw draft here suppressed every later completion
        // for the whole session.
        dismissed.current = suggestion !== '' ? suggestion : `${draft}\u0000local`;
        setSuggestion('');
        setSource('');
      }, [suggestion, draft]);

      // Keyboard: Tab accepts, Escape dismisses -- but only from the composer,
      // and only while a suggestion is actually on screen.
      React.useEffect(() => {
        if (typeof document === 'undefined') return undefined;
        const onKeyDown = (event) => {
          if (event.defaultPrevented || event.isComposing) return;
          const hasSuggestion = suggestion !== '' || local !== null;
          if (!hasSuggestion) return;
          if (!inComposer()) return;
          if (event.key === 'Tab' && event.shiftKey !== true && event.ctrlKey !== true && event.metaKey !== true && event.altKey !== true) {
            if (acceptSuggested()) {
              event.preventDefault();
              event.stopPropagation();
            }
            return;
          }
          if (event.key === 'Escape') {
            dismiss();
            event.preventDefault();
            event.stopPropagation();
          }
        };
        document.addEventListener('keydown', onKeyDown, true);
        return () => document.removeEventListener('keydown', onKeyDown, true);
      }, [acceptSuggested, dismiss, suggestion, local]);

      /* ------------------------------------------------------------ render */

      // NOTE: no early `return` may appear above this point, and none may appear
      // between two hook calls. `enabled` flips from false to true when the
      // settings arrive; returning early on the false pass would make this
      // component render FEWER hooks than the next pass, and React throws
      // "Rendered more hooks than during the previous render". That crash is
      // swallowed by the slot renderer -- the composer simply stayed empty with
      // no visible error. The disabled case is handled inside the paint effect.

      // Two independent sources of text:
      //   - a model prediction replaces the whole message;
      //   - a history completion only supplies the REMAINDER of a message whose
      //     prefix the user already typed.
      // They must be painted differently. Showing a completion's full text next
      // to a draft it starts with looks like the draft being repeated, and
      // accepting it would insert the sentence twice.
      //
      // A MODEL prediction describes a message for an EMPTY composer, so it is
      // only valid while the composer is empty and the agent is idle. Without
      // these two conditions the stale suggestion stayed painted after sending
      // (the draft went empty again) and then overlapped whatever the user typed
      // next, because it is anchored at the editor origin.
      const modelText = suggestion !== '' && suggestion !== dismissed.current && blankDraft && !running
        ? suggestion
        : '';
      const localSuffix = local !== null ? local.suffix : '';

      // What one paint should show.
      //
      // A prediction for an EMPTY composer is the whole message. A completion is
      // ONLY the remainder, preceded by the typed draft as invisible text so it
      // starts exactly after it. Painting `draft + remainder` as visible text
      // double-drew the user's own characters.
      const ghostText = modelText !== '' ? modelText : localSuffix;
      const ghostPrefix = modelText !== '' ? '' : draft;

      // A prediction belongs to ONE finished turn, so there are two different
      // ways for it to stop applying:
      //
      //   typing   -> only HIDE it. The text is still the answer to "what might
      //               you send next"; clearing the box must bring it back.
      //   a turn   -> DISCARD it. Once a turn runs, that prediction describes a
      //               moment that has passed, and leaving it in state made it
      //               reappear after sending (it did: the stale sentence sat in an
      //               empty composer while the agent was working).
      //
      // The render guard below handles the hiding; this effect handles the
      // discarding, and it must key on `running` ALONE. Including `blankDraft`
      // here deleted the suggestion the moment the user typed, so emptying the
      // composer afterwards had nothing to restore.
      React.useEffect(() => {
        if (suggestion === '') return;
        if (!running) return;
        setSuggestion('');
        setSource('');
      }, [suggestion, running]);

      // The suggestion is drawn INSIDE the composer card as ghost text, so this
      // component renders no element of its own. It stays mounted to hold the
      // state and keep the Tab/Escape listeners alive.
      React.useEffect(() => {
        if (typeof document === "undefined") return undefined;
        if (!enabled) {
          clearGhost(document);
          return undefined;
        }
        if (phase === "submitting") {
          paintGhost(document, sessionId, "");
          return undefined;
        }

        if (ghostText === "") {
          paintGhost(document, sessionId, "");
          return undefined;
        }

        // Text only: acceptance is Tab and dismissal is Escape. Buttons inside the
        // composer pushed the text around and read as a stray widget.
        paintGhost(document, sessionId, ghostText, { prefix: ghostPrefix });
        return undefined;
      });

      // Leaving this session, or unmounting, must not leave stale ghost text
      // floating over an empty composer.
      React.useEffect(() => () => {
        if (typeof document !== "undefined") clearGhost(document);
      }, []);

      return null;
    }

    /* ----------------------------------------------------------- settings */

    const rowStyle = {
      display: 'flex',
      alignItems: 'flex-start',
      justifyContent: 'space-between',
      gap: 16,
      padding: '10px 0',
      borderBottom: '1px solid var(--dsw-alias-border-secondary, #8882)',
    };
    const labelStyle = { fontSize: 13, color: 'var(--dsw-alias-label-primary, inherit)' };
    const hintStyle = { fontSize: 12, marginTop: 2, color: 'var(--dsw-alias-label-secondary, #6b7280)' };
    const inputStyle = {
      flexShrink: 0,
      minWidth: 110,
      padding: '4px 8px',
      borderRadius: 6,
      border: '1px solid var(--dsw-alias-border-primary, #8884)',
      background: 'var(--dsw-alias-bg-primary, transparent)',
      color: 'inherit',
      font: 'inherit',
    };

    function clampTo(key, value) {
      const range = RANGES[key];
      const number = Number(value);
      if (!Number.isFinite(number)) return DEFAULT_SETTINGS[key];
      const rounded = Math.floor(number);
      if (range === undefined) return rounded;
      return Math.min(range[1], Math.max(range[0], rounded));
    }

    function SettingsPage(props) {
      // Same fallback as the ghost entry: a missing locale face must not turn the
      // settings page into a blank panel.
      const t = typeof props.t === 'function'
        ? props.t
        : (key) => (Object.prototype.hasOwnProperty.call(zh, key) ? zh[key] : key);
      const [value, setValue] = React.useState(settingsStore.value);
      const [status, setStatus] = React.useState('');
      const [now, setNow] = React.useState(() => Date.now());
      const alive = React.useRef(true);

      React.useEffect(() => {
        alive.current = true;
        return () => { alive.current = false; };
      }, []);

      React.useEffect(() => settingsStore.subscribe(() => setValue(settingsStore.value)), []);
      React.useEffect(() => {
        if (settingsStore.value === null) void loadSettings();
      }, []);
      // Only needed to redraw the pause countdown.
      React.useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
      }, []);

      const save = React.useCallback(async (patch) => {
        setStatus('saving');
        try {
          const body = await saveSettings(patch);
          if (!alive.current) return;
          setStatus(body && body.ok === true ? 'saved' : 'failed');
        } catch {
          if (alive.current) setStatus('failed');
        }
      }, []);

      const current = value || DEFAULT_SETTINGS;
      const paused = isPaused(current, now);
      const remaining = paused ? Math.max(0, Math.ceil((Number(current.pausedUntil) - now) / 1000)) : 0;
      const countdown = remaining >= 60
        ? `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`
        : String(remaining);

      const toggle = (key) => (event) => { void save({ [key]: event.target.checked }); };
      const number = (key, min, max) => h('input', {
        type: 'number',
        min,
        max,
        style: inputStyle,
        value: current[key] === undefined ? '' : String(current[key]),
        onChange: (event) => {
          // Ignore the transient empty string while the user retypes: saving it
          // as 0 is what silently disables a feature.
          if (event.target.value === '') return;
          const next = clampTo(key, event.target.value);
          void save({ [key]: next });
        },
      });
      const select = (key, options) => h('select', {
        style: inputStyle,
        value: current[key],
        onChange: (event) => { void save({ [key]: event.target.value }); },
      }, options.map((option) => h('option', { key: option.value, value: option.value }, t(option.label))));

      return h('div', { style: { padding: '4px 0 24px' } },
        h('h2', { style: { fontSize: 16, margin: '0 0 6px' } }, t('settingsTitle')),
        h('p', { style: { fontSize: 12, margin: '0 0 4px', ...hintStyle } }, t('settingsIntro')),
        h('p', { style: { fontSize: 12, margin: '0 0 16px', ...hintStyle } }, t('costWarning')),

        settingsStore.error === undefined ? null : h('p', {
          style: { fontSize: 12, margin: '0 0 16px', color: 'var(--dsw-alias-state-warning-primary, #b45309)' },
        }, t('settingsLoadFailed')),

        h('div', { style: rowStyle },
          h('div', null, h('div', { style: labelStyle }, t('settingsEnabled')), h('div', { style: hintStyle }, t('settingsEnabledHint'))),
          h('input', { type: 'checkbox', checked: current.enabled === true, onChange: toggle('enabled') })),

        h('div', { style: rowStyle },
          h('div', null, h('div', { style: labelStyle }, t('settingsMode')), h('div', { style: hintStyle }, t('settingsModeHint'))),
          select('mode', [
            { value: 'auto', label: 'settingsModeAuto' },
            { value: 'manual', label: 'settingsModeManual' },
          ])),

        h('div', { style: rowStyle },
          h('div', null, h('div', { style: labelStyle }, t('settingsMaxChars')), h('div', { style: hintStyle }, t('settingsMaxCharsHint'))),
          number('maxSuggestionChars', 20, 400)),

        h('div', { style: rowStyle },
          h('div', null, h('div', { style: labelStyle }, t('settingsContextMessages')), h('div', { style: hintStyle }, t('settingsContextMessagesHint'))),
          number('contextMessages', 2, 20)),

        h('div', { style: rowStyle },
          h('div', null, h('div', { style: labelStyle }, t('settingsContextChars')), h('div', { style: hintStyle }, t('settingsContextCharsHint'))),
          number('contextChars', 1000, 20000)),

        h('div', { style: rowStyle },
          h('div', null, h('div', { style: labelStyle }, t('settingsTimeout')), h('div', { style: hintStyle }, t('settingsTimeoutHint'))),
          number('timeoutMs', 2000, 60000)),

        h('div', { style: rowStyle },
          h('div', null, h('div', { style: labelStyle }, t('settingsHistory')), h('div', { style: hintStyle }, t('settingsHistoryHint'))),
          h('input', { type: 'checkbox', checked: current.historyEnabled === true, onChange: toggle('historyEnabled') })),

        h('div', { style: rowStyle },
          h('div', null, h('div', { style: labelStyle }, t('settingsHistoryMinChars')), h('div', { style: hintStyle }, t('settingsHistoryMinCharsHint'))),
          number('historyMinChars', 1, 8)),

        h('div', { style: rowStyle },
          h('div', null,
            h('div', { style: labelStyle }, t(paused ? 'settingsResume' : 'settingsPause')),
            h('div', { style: hintStyle }, t(paused ? 'settingsResumeHint' : 'settingsPauseHint'))),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            paused ? h('span', { style: hintStyle }, countdown) : null,
            h('button', {
              type: 'button',
              style: { ...inputStyle, cursor: 'pointer' },
              onClick: () => {
                void save({ pausedUntil: paused ? 0 : Math.floor(Date.now() + 10 * 60 * 1000) });
              },
            }, t(paused ? 'settingsResume' : 'settingsPause')))),

        h('div', { style: { ...rowStyle, borderBottom: 'none' } },
          h('div', null, h('div', { style: labelStyle }, t('settingsProvider')), h('div', { style: hintStyle }, t('settingsProviderHint'))),
          h('input', {
            type: 'text',
            style: { ...inputStyle, minWidth: 180 },
            placeholder: current.provider === '' ? t('settingsInherit') : '',
            value: current.provider,
            onChange: (event) => { void save({ provider: event.target.value.trim() }); },
          })),

        h('div', { style: { ...rowStyle, borderBottom: 'none' } },
          h('div', null, h('div', { style: labelStyle }, t('settingsModel')), h('div', { style: hintStyle }, t('settingsModelHint'))),
          h('input', {
            type: 'text',
            style: { ...inputStyle, minWidth: 180 },
            placeholder: current.model === '' ? t('settingsInherit') : '',
            value: current.model,
            onChange: (event) => { void save({ model: event.target.value.trim() }); },
          })),

        h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, paddingTop: 14 } },
          h('button', {
            type: 'button',
            style: { ...inputStyle, cursor: 'pointer' },
            onClick: () => { void save({ reset: true }); },
          }, t('settingsReset')),
          h('span', { style: hintStyle }, t('settingsResetHint')),
          h('span', { style: hintStyle }, status === 'saving' ? t('settingsSaving') : status === 'saved' ? t('settingsSaved') : status === 'failed' ? t('settingsFailed') : '')),
      );
    }

    /* -------------------------------------------------------------- wiring */

    function apply(ctx) {
      // `locale` is declared in `inject`, so Cordis waits for it instead of
      // racing the service.
      const locale = ctx.locale;
      if (locale && typeof locale.register === 'function') {
        ctx.effect(() => locale.register(NS, { zh, en }), 'next-say dictionaries');
      }

      // `conversation.input.overlay` renders INSIDE the composer card (the
      // `.overlayAnchor` child of `[data-composer-card]`), which is what "in the
      // input box" means here. The entry itself renders no element: it paints
      // ghost text over the editor and returns null.
      ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
        name: 'conversation.input.overlay',
        id: 'next-say',
        order: 5,
        locale: NS,
      }, SuggestionRow));

      // The settings page is root-scoped: it must exist even with no session.
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'next-say',
        order: 37,
        locale: NS,
        label: () => ctx.locale.bind(NS)('settingsNav'),
      }, SettingsPage));
    }

    const moduleExports = {
      name: 'next-say',
      inject: ['slots', 'locale'],
      apply,
      // Exposed so the Host-side tests can exercise the exact shipped logic
      // rather than a copy of it.
      __internals: {
        NS,
        API,
        zh,
        en,
        DEFAULT_SETTINGS,
        RANGES,
        isPaused,
        clampTo,
        inComposer,
        historyCompletion,
        normalizeForMatch,
        SuggestionRow,
        GhostPainter,
        settingsStore,
        SettingsPage,
      },
    };
    return moduleExports;
  },
});
