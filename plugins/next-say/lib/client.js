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

        const zh = {
      title: "\u4e0b\u4e00\u53e5\u5efa\u8bae",
      idle: "\u4e0b\u4e00\u53e5\u5efa\u8bae",
      tab: "Tab",
      accept: "\u91c7\u7eb3",
      reroll: "\u6362\u4e00\u6761",
      dismiss: "\u5ffd\u7565",
      thinking: "\u6b63\u5728\u60f3\u4e0b\u4e00\u53e5\u2026",
      manual: "\u9884\u6d4b",
      manualBusy: "\u9884\u6d4b\u4e2d\u2026",
      paused: "\u5df2\u6682\u505c",
      pausedHint: "\u9884\u6d4b\u5df2\u6682\u505c\uff0c\u5230\u70b9\u81ea\u52a8\u6062\u590d\u3002",
      empty: "\u6682\u65e0\u5efa\u8bae",
      failed: "\u6ca1\u9884\u6d4b\u51fa\u6765",
      hintTab: "Tab \u586b\u5165\u8349\u7a3f\uff0c\u4e0d\u4f1a\u53d1\u9001",
      tabAccept: "Tab \u91c7\u7eb3",
      settingsNav: "\u4e0b\u4e00\u53e5\u5efa\u8bae",
      settingsTitle: "\u4e0b\u4e00\u53e5\u5efa\u8bae",
      settingsIntro: "\u56de\u5408\u7ed3\u675f\u540e\u9884\u6d4b\u4f60\u7684\u4e0b\u4e00\u53e5\u8bdd\uff1b\u8f93\u5165\u8349\u7a3f\u65f6\u7528\u672c\u5730\u5386\u53f2\u505a\u524d\u7f00\u8865\u5168\u3002\u4e24\u79cd\u5efa\u8bae\u90fd\u53ea\u586b\u5165\u8349\u7a3f\uff0c\u4e0d\u4f1a\u81ea\u52a8\u53d1\u9001\u3002",
      settingsEnabled: "\u542f\u7528\u5efa\u8bae",
      settingsEnabledHint: "\u5173\u95ed\u540e\u65e2\u4e0d\u518d\u9884\u6d4b\uff0c\u4e5f\u4e0d\u518d\u663e\u793a\u5386\u53f2\u8865\u5168\u3002",
      settingsMode: "\u9884\u6d4b\u65f6\u673a",
      settingsModeHint: "\u81ea\u52a8\uff1a\u6bcf\u8f6e\u56de\u7b54\u7ed3\u675f\u540e\u9884\u6d4b\u4e00\u6b21\uff08\u6bcf\u6b21\u90fd\u662f\u771f\u5b9e\u8ba1\u8d39\u8c03\u7528\uff09\u3002\u624b\u52a8\uff1a\u53ea\u5728\u70b9\u300c\u9884\u6d4b\u300d\u65f6\u8c03\u7528\u3002",
      settingsModeAuto: "\u81ea\u52a8",
      settingsModeManual: "\u4ec5\u624b\u52a8",
      settingsMaxChars: "\u5efa\u8bae\u5b57\u6570\u4e0a\u9650",
      settingsMaxCharsHint: "\u5efa\u8bae\u6700\u957f\u591a\u5c11\u4e2a\u5b57\u7b26\u3002\u4e2d\u6587\u6309\u5b57\uff0c\u82f1\u6587\u6309\u5b57\u7b26\u3002",
      settingsContextMessages: "\u53c2\u8003\u6d88\u606f\u6761\u6570",
      settingsContextMessagesHint: "\u9884\u6d4b\u65f6\u6700\u591a\u8bfb\u53d6\u6700\u8fd1\u591a\u5c11\u6761\u6d88\u606f\u3002",
      settingsContextChars: "\u4e0a\u4e0b\u6587\u9884\u7b97",
      settingsContextCharsHint: "\u8fd9\u4e9b\u6d88\u606f\u5408\u8ba1\u6700\u591a\u591a\u5c11\u4e2a\u5b57\u7b26\u3002",
      settingsTimeout: "\u8d85\u65f6\uff08\u6beb\u79d2\uff09",
      settingsTimeoutHint: "\u8d85\u65f6\u540e\u4e22\u5f03\u8fd9\u4e00\u6b21\u7ed3\u679c\uff0c\u4e0d\u663e\u793a\u9519\u8bef\u3001\u4e0d\u81ea\u52a8\u91cd\u8bd5\u3002",
      settingsHistory: "\u5386\u53f2\u524d\u7f00\u8865\u5168",
      settingsHistoryHint: "\u8f93\u5165\u65f6\u7528\u672c\u4f1a\u8bdd\u5df2\u53d1\u8fc7\u7684\u6d88\u606f\u505a\u7070\u5b57\u8865\u5168\uff0c\u4e0d\u4ea7\u751f\u4efb\u4f55\u6a21\u578b\u8c03\u7528\u3002",
      settingsHistoryMinChars: "\u6700\u5c11\u8f93\u5165\u5b57\u6570",
      settingsHistoryMinCharsHint: "\u8f93\u5165\u5230\u8fd9\u4e48\u591a\u4e2a\u5b57\u624d\u5f00\u59cb\u8865\u5168\u3002",
      settingsProvider: "\u9884\u6d4b\u6a21\u578b",
      settingsProviderHint: "\u7559\u7a7a\u5219\u8ddf\u968f\u5f53\u524d\u4f1a\u8bdd\u4f7f\u7528\u7684\u6a21\u578b\u3002",
      settingsInherit: "\u8ddf\u968f\u4f1a\u8bdd",
      settingsModel: "\u6a21\u578b",
      settingsModelHint: "\u53ea\u5728\u9700\u8981\u6362\u5230\u66f4\u4fbf\u5b9c\u7684\u6a21\u578b\u65f6\u8bbe\u7f6e\u3002",
      settingsPause: "\u6682\u505c\u5341\u5206\u949f",
      settingsPauseHint: "\u6682\u505c\u671f\u95f4\u4e0d\u53d1\u8d77\u4efb\u4f55\u9884\u6d4b\u8c03\u7528\uff0c\u5230\u70b9\u81ea\u52a8\u6062\u590d\u3002",
      settingsResume: "\u6062\u590d\u9884\u6d4b",
      settingsResumeHint: "\u5f53\u524d\u5904\u4e8e\u6682\u505c\u72b6\u6001\uff0c\u70b9\u6b64\u7acb\u5373\u6062\u590d\u3002",
      settingsReset: "\u6062\u590d\u9ed8\u8ba4",
      settingsResetHint: "\u628a\u6240\u6709\u8bbe\u7f6e\u6062\u590d\u4e3a\u9ed8\u8ba4\u503c\u3002",
      settingsSave: "\u4fdd\u5b58",
      settingsSaved: "\u5df2\u4fdd\u5b58",
      settingsSaving: "\u6b63\u5728\u4fdd\u5b58\u2026",
      settingsFailed: "\u4fdd\u5b58\u5931\u8d25",
      settingsLoadFailed: "\u8bfb\u53d6\u8bbe\u7f6e\u5931\u8d25\uff0c\u5f53\u524d\u663e\u793a\u7684\u662f\u9ed8\u8ba4\u503c\u3002",
      costWarning: "\u6bcf\u6b21\u81ea\u52a8\u9884\u6d4b\u90fd\u662f\u4e00\u6b21\u771f\u5b9e\u8ba1\u8d39\u7684\u6a21\u578b\u8c03\u7528\u3002",
      never: "\u4ece\u4e0d",
    };

    const en = {
      title: "Next-say suggestions",
      idle: "Next-say",
      tab: "Tab",
      accept: "Accept",
      reroll: "Another",
      dismiss: "Dismiss",
      thinking: "Thinking of your next message\u2026",
      manual: "Predict",
      manualBusy: "Predicting\u2026",
      paused: "Paused",
      pausedHint: "Predictions are paused and resume automatically.",
      empty: "No suggestion yet",
      failed: "Could not predict",
      hintTab: "Tab fills the draft; it never sends",
      tabAccept: "Tab accept",
      settingsNav: "Next-say",
      settingsTitle: "Next-say suggestions",
      settingsIntro: "Predicts your next message after each finished turn, and completes a draft from local history. Neither is sent for you: Tab only fills the draft.",
      settingsEnabled: "Enable suggestions",
      settingsEnabledHint: "Turning this off stops both model predictions and history completion.",
      settingsMode: "When to predict",
      settingsModeHint: "Auto: once after every finished turn (each one is a real billed call). Manual: only when you press Predict.",
      settingsModeAuto: "Automatic",
      settingsModeManual: "Manual only",
      settingsMaxChars: "Suggestion length",
      settingsMaxCharsHint: "Longest suggested message, in characters.",
      settingsContextMessages: "Messages considered",
      settingsContextMessagesHint: "How many recent messages a prediction may read.",
      settingsContextChars: "Context budget",
      settingsContextCharsHint: "Character cap across those messages.",
      settingsTimeout: "Timeout (ms)",
      settingsTimeoutHint: "A timeout drops that result silently: no error, no automatic retry.",
      settingsHistory: "History completion",
      settingsHistoryHint: "Completes from messages already sent in this conversation. Makes no model call.",
      settingsHistoryMinChars: "Minimum draft length",
      settingsHistoryMinCharsHint: "How many characters to type before completion starts.",
      settingsProvider: "Prediction model",
      settingsProviderHint: "Leave empty to follow the model the current session uses.",
      settingsInherit: "Follow the session",
      settingsModel: "Model",
      settingsModelHint: "Set this only to move predictions to a cheaper model.",
      settingsPause: "Pause for ten minutes",
      settingsPauseHint: "No prediction call is made while paused; it resumes automatically.",
      settingsResume: "Resume predictions",
      settingsResumeHint: "Predictions are paused right now; press to resume immediately.",
      settingsReset: "Reset to defaults",
      settingsResetHint: "Restore every setting to its default value.",
      settingsSave: "Save",
      settingsSaved: "Saved",
      settingsSaving: "Saving\u2026",
      settingsFailed: "Could not save",
      settingsLoadFailed: "Could not read the settings; showing defaults.",
      costWarning: "Every automatic prediction is a real, billed model call.",
      never: "Never",
    };

    const LOCALES = { zh, en };
    const KEY_COUNT = 54;

        /** Full-width and ASCII variants are unified before matching, never for display. */
    const NORMALIZE_STRIP = /[\s\u3000]+/g;

    /**
     * Comparison key for a draft or candidate.
     *
     * Width, case and internal whitespace differences are typing accidents, so they
     * must not break a match. The returned string is only ever used for comparison;
     * the text shown to the user is always the candidate's original bytes.
     */
    function normalizeForMatch(text) {
      return String(text ?? '')
        .toLowerCase()
        .replace(NORMALIZE_STRIP, '')
        .replace(/[\u2018\u2019\u201c\u201d]/g, '"')
        .replace(/\u3002/g, '.')
        .replace(/\uff0c/g, ',')
        .replace(/\uff1a/g, ':')
        .replace(/\uff1b/g, ';')
        .replace(/\uff1f/g, '?')
        .replace(/\uff01/g, '!')
        .replace(/[\uff01-\uff5e]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0));
    }

    /**
     * Recency bucket of a history entry: 4 = newest quarter, 0 = oldest.
     *
     * Buckets, not exact positions, because "roughly this recent" is the real
     * signal. Exact-position scoring claims a precision the ranking does not have,
     * and makes equally plausible candidates impossible to tie-break.
     */
    const RECENCY_BUCKETS = 4;

    function recencyRank(index, total) {
      if (total <= 1) return RECENCY_BUCKETS;
      return Math.floor((index / (total - 1)) * RECENCY_BUCKETS);
    }

    /**
     * Score a candidate against the normalized draft.
     *
     * Returns null when the candidate cannot be offered at all (not a prefix match,
     * or identical to the draft, so there would be nothing left to ghost).
     */
    function scoreCandidate(candidate, query, rank) {
      const normalizedCandidate = normalizeForMatch(candidate);
      if (normalizedCandidate.length <= query.length) return null;
      if (!normalizedCandidate.startsWith(query)) return null;

      // Two-level decision, so the rule is explainable:
      //   1. a newer bucket always wins;
      //   2. inside one bucket, the SHORTER remainder wins (less to read), and the
      //      first candidate in chronological order wins a true tie.
      const extra = normalizedCandidate.length - query.length;
      return {
        bucket: rank,
        score: rank * 10000 - Math.min(extra, 9999),
        extra,
      };
    }

    /**
     * Pick the completion to ghost.
     *
     * @param {ReadonlyArray<{text: string, role?: string}>} history
     *   Messages in chronological order. Only `role: 'user'` entries are eligible
     *   by default: completing the assistant's prose would suggest the user repeat
     *   it back.
     * @param {string} draft The current draft.
     * @param {object} [options]
     * @param {number} [options.minChars] Shortest draft that may trigger a completion.
     * @param {number} [options.maxEntries] Newest N history entries considered.
     * @param {boolean} [options.includeAssistant] Also complete from assistant text.
     * @param {number} [options.maxExtraChars] Longest ghosted remainder.
     * @returns {{suffix: string, full: string, source: string} | null}
     */
    function historyCompletion(history, draft, options = {}) {
      const minChars = Number.isFinite(options.minChars) ? Math.max(1, Math.floor(options.minChars)) : 2;
      const maxEntries = Number.isFinite(options.maxEntries) && options.maxEntries > 0
        ? Math.floor(options.maxEntries)
        : 200;
      const maxExtraChars = Number.isFinite(options.maxExtraChars) && options.maxExtraChars > 0
        ? Math.floor(options.maxExtraChars)
        : 400;
      const includeAssistant = options.includeAssistant === true;

      const text = String(draft ?? '');
      const query = normalizeForMatch(text);
      if (query.length < minChars) return null;

      const candidates = [];
      const items = Array.isArray(history) ? history.slice(-maxEntries) : [];
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        if (!item || typeof item.text !== 'string') continue;
        if (!includeAssistant && item.role === 'assistant') continue;
        // A one-character message is not worth completing.
        if (item.text.trim().length < 2) continue;
        candidates.push({ text: item.text, rank: recencyRank(index, items.length) });
      }
      if (candidates.length === 0) return null;

      let best = null;
      for (const candidate of candidates) {
        const scored = scoreCandidate(candidate.text, query, candidate.rank);
        if (scored === null) continue;
        if (best === null || scored.score > best.scored.score) {
          best = { candidate, scored };
        }
      }
      if (best === null) return null;

      // The ghost text is the candidate's tail measured in ORIGINAL characters, so
      // the visible remainder lines up with the bytes on screen. When the draft
      // itself differs only in width/case, the candidate's own prefix is the one
      // that matches, and the remainder is still what the user has not typed.
      const full = best.candidate.text;
      const normalizedFull = normalizeForMatch(full);
      let cut = query.length;
      // Walk the original string until its normalized form has consumed the query.
      let consumed = 0;
      let position = 0;
      while (position < full.length && consumed < cut) {
        consumed += normalizeForMatch(full[position]).length;
        position += 1;
      }
      const suffix = full.slice(position);
      if (suffix === '') return null;
      if (suffix.length > maxExtraChars) return null;

      return { suffix, full, source: 'history' };
    }

        /**
     * Remove every child of a node.
     *
     * Walks `children` when it is a live collection (real DOM and the test double
     * both provide one) and falls back to `firstChild`. A bare
     * `while (node.firstChild !== null)` loop spins forever on a host object without
     * that property, which is how a test run hung.
     */
    function clearChildren(node) {
      const kids = node.children;
      if (kids !== undefined && kids !== null && typeof kids.length === 'number') {
        for (let index = kids.length - 1; index >= 0; index -= 1) node.removeChild(kids[index]);
        return;
      }
      for (let guard = 0; guard < 64; guard += 1) {
        if (node.firstChild === undefined || node.firstChild === null) return;
        node.removeChild(node.firstChild);
      }
    }

    /** Attribute marking OUR layer, so another plugin's node is never touched. */
    const GHOST_ATTR = 'data-next-say-ghost';

    /** Style element id, removed with the plugin. */
    const STYLE_ID = 'next-say-ghost-style';

    /** The single layer this module owns (one composer is visible at a time). */
    let layer = null;
    let observer = null;
    let onResize = null;
    let onScroll = null;
    let watchedWindow = null;
    /** The host placeholder this module hid, and how it was displayed before. */
    let hiddenPlaceholder = null;
    let placeholderWas = '';

    function ensureStyle(doc) {
      if (doc.getElementById(STYLE_ID) !== null) return;
      const style = doc.createElement('style');
      style.id = STYLE_ID;
      style.textContent = `
    [${GHOST_ATTR}] {
      position: absolute;
      pointer-events: none;
      user-select: none;
      overflow: hidden;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      word-break: break-word;
      z-index: 1;
      display: none;
      color: var(--dsw-alias-label-caption, #9ca3af);
      opacity: 0.85;
    }
    [${GHOST_ATTR}][data-shown="1"] { display: block; }
      `;
      doc.head.appendChild(style);
    }

    /**
     * Find the composer editor for a session.
     *
     * Scoped by the conversation element when possible: with several sessions
     * rendered, an unscoped query can measure another session's composer.
     */
    function findEditor(doc, sessionId) {
      const scoped = sessionId === undefined || sessionId === null || sessionId === ''
        ? null
        : doc.querySelector(`[data-conversation-session="${String(sessionId).replace(/"/g, '\\"')}"] [data-composer-input="true"]`);
      if (scoped !== null && scoped !== undefined) return scoped;
      return doc.querySelector('[data-composer-input="true"]');
    }

    /** Hide the host placeholder so it cannot sit under the ghost. */
    function hidePlaceholder(doc, editor) {
      const host = editor === null || editor === undefined ? null : editor.parentElement;
      if (host === null || host === undefined) return;
      const node = typeof host.querySelector === 'function' ? host.querySelector('[data-composer-placeholder]') : null;
      if (node === null || node === undefined) return;
      // Re-resolve every time: the remembered node may belong to a composer that has
      // since been replaced (session switch, remount), and leaving THAT one hidden
      // while hiding nothing here is how a stale reference turns into a missing
      // placeholder.
      if (hiddenPlaceholder === node) return;
      if (hiddenPlaceholder !== null) restorePlaceholder();
      hiddenPlaceholder = node;
      placeholderWas = node.style.display;
      node.style.display = 'none';
    }

    /** Put the placeholder back exactly as it was. */
    function restorePlaceholder() {
      if (hiddenPlaceholder === null) return;
      hiddenPlaceholder.style.display = placeholderWas;
      hiddenPlaceholder = null;
      placeholderWas = '';
    }

    /**
     * Put the layer at the editor's content origin.
     *
     * The layer is NOT positioned at the caret. A caret rect from a collapsed range
     * was off by about one CJK glyph horizontally and a couple of pixels vertically
     * on screen, so the ghost landed on top of the last typed character. Instead the
     * layer starts where the text starts and carries the already-typed prefix as
     * INVISIBLE text; the ghost then flows immediately after it with the editor's own
     * font metrics. Alignment stops depending on measurement.
     */
    function place(doc) {
      if (layer === null) return false;
      const editor = findEditor(doc, layer.dataset.session);
      if (editor === null || editor === undefined) return false;
      const host = editor.parentElement;
      if (host === null || host === undefined) return false;

      const hostRect = host.getBoundingClientRect();
      const rect = editor.getBoundingClientRect();
      const computed = doc.defaultView.getComputedStyle(editor);
      const padLeft = parseFloat(computed.paddingLeft) || 0;
      const padRight = parseFloat(computed.paddingRight) || 0;
      const padTop = parseFloat(computed.paddingTop) || 0;

      layer.style.left = `${rect.left - hostRect.left + padLeft}px`;
      layer.style.top = `${rect.top - hostRect.top + padTop}px`;
      layer.style.width = `${Math.max(60, rect.width - padLeft - padRight)}px`;
      layer.style.fontFamily = computed.fontFamily;
      layer.style.fontSize = computed.fontSize;
      layer.style.lineHeight = computed.lineHeight;
      layer.style.fontWeight = computed.fontWeight;
      layer.style.letterSpacing = computed.letterSpacing;
      return true;
    }

    /** Create the layer once and keep it attached to the current editor host. */
    function ensureLayer(doc, sessionId) {
      const editor = findEditor(doc, sessionId);
      if (editor === null || editor === undefined) return null;
      const host = editor.parentElement;
      if (host === null || host === undefined) return null;

      if (layer === null) {
        layer = doc.createElement('div');
        layer.setAttribute(GHOST_ATTR, '');
        layer.setAttribute('aria-hidden', 'true');
        layer.dataset.shown = '0';
      }
      if (layer.parentElement !== host) host.appendChild(layer);
      layer.dataset.session = sessionId === undefined || sessionId === null ? '' : String(sessionId);
      return layer;
    }

    /**
     * Re-measure on anything that can move the editor or the caret.
     *
     * Listeners live in module state so `clearGhost` removes them: adding
     * capture-phase resize/scroll listeners per mount and never removing them leaks
     * one pair per mount for the life of the page.
     */
    function watch(doc) {
      if (watchedWindow !== null) return;
      const win = doc.defaultView;
      if (win === null || win === undefined) return;
      watchedWindow = win;
      if (typeof ResizeObserver !== 'undefined') {
        observer = new ResizeObserver(() => place(doc));
        const editor = findEditor(doc, layer === null ? undefined : layer.dataset.session);
        if (editor !== null && editor !== undefined) observer.observe(editor);
      }
      onResize = () => place(doc);
      onScroll = () => place(doc);
      win.addEventListener('resize', onResize, true);
      win.addEventListener('scroll', onScroll, true);
    }

    /**
     * Render, re-measure or clear the ghost.
     *
     * @param {Document} doc
     * @param {string|undefined} sessionId
     * @param {string} text      Text to ghost. Empty clears it.
     * @param {object} [options]
     * @param {string} [options.prefix] Already-typed text to reserve space for, so a
     *   continuation starts exactly after it. Painted invisibly.
     */
    function paintGhost(doc, sessionId, text, options = {}) {
      if (typeof doc === 'undefined' || doc === null) return;
      ensureStyle(doc);

      const node = ensureLayer(doc, sessionId);
      if (node === null) {
        restorePlaceholder();
        return;
      }
      if (node.dataset.watched !== '1') {
        node.dataset.watched = '1';
        watch(doc);
      }

      if (text === '') {
        node.dataset.shown = '0';
        clearChildren(node);
        restorePlaceholder();
        return;
      }

      if (!place(doc)) {
        node.dataset.shown = '0';
        restorePlaceholder();
        return;
      }

      // Rebuild the children (node-by-node, never innerHTML).
      clearChildren(node);

      const prefix = typeof options.prefix === 'string' ? options.prefix : '';
      if (prefix !== '') {
        // The already-typed text occupies its real width but paints nothing, so the
        // ghost begins exactly one glyph after it and wraps with it.
        const spacer = doc.createElement('span');
        spacer.setAttribute('data-next-say-spacer', '');
        spacer.style.visibility = 'hidden';
        spacer.textContent = prefix;
        node.appendChild(spacer);
      }
      const ghost = doc.createElement('span');
      ghost.setAttribute('data-next-say-text', '');
      ghost.textContent = text;
      node.appendChild(ghost);

      hidePlaceholder(doc, findEditor(doc, sessionId));
      node.dataset.shown = '1';
    }

    /** Remove the layer, its stylesheet, its listeners, and restore the placeholder. */
    function clearGhost(doc) {
      restorePlaceholder();
      if (typeof doc === 'undefined' || doc === null) return;
      if (layer !== null) {
        layer.remove();
        layer = null;
      }
      if (observer !== null) {
        observer.disconnect();
        observer = null;
      }
      if (watchedWindow !== null) {
        if (onResize !== null) watchedWindow.removeEventListener('resize', onResize, true);
        if (onScroll !== null) watchedWindow.removeEventListener('scroll', onScroll, true);
      }
      watchedWindow = null;
      onResize = null;
      onScroll = null;
      const style = doc.getElementById(STYLE_ID);
      if (style !== null) style.remove();
    }

    /** Exposed for tests: whether a ghost is currently attached and shown. */
    function ghostState() {
      return layer === null ? null : { shown: layer.dataset.shown === '1', session: layer.dataset.session };
    }

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
