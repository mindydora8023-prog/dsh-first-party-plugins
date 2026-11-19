/**
 * Browser half of dsh-plugin-next-say.
 *
 * Registers ONE headless entry into `conversation.input.overlay` -- the slot that
 * renders INSIDE the composer card -- plus a page in Settings. The entry draws no
 * element of its own: it paints ghost text over the editor (lib/ghost.js) and
 * keeps the Tab/Escape handling, which goes through the composer's own
 * `insertText` so a concurrent edit can never be overwritten. Tab accepts the
 * whole remainder; Ctrl/Cmd+Right accepts only the next word (Copilot / Continue).
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
      "title": "\u4e0b\u4e00\u53e5\u5efa\u8bae",
      "idle": "\u4e0b\u4e00\u53e5\u5efa\u8bae",
      "tab": "Tab",
      "accept": "\u91c7\u7eb3",
      "reroll": "\u6362\u4e00\u6761",
      "dismiss": "\u5ffd\u7565",
      "thinking": "\u6b63\u5728\u60f3\u4e0b\u4e00\u53e5\u2026",
      "manual": "\u9884\u6d4b",
      "manualPredict": "\u9884\u6d4b\u4e0b\u4e00\u53e5",
      "manualHint": "\u70b9\u51fb\u9884\u6d4b\u4e0b\u4e00\u53e5\uff1b\u5efa\u8bae\u53ea\u586b\u5165\u8349\u7a3f\uff0c\u4e0d\u4f1a\u53d1\u9001\u3002",
      "manualReady": "\u5efa\u8bae\u5df2\u663e\u793a\u5728\u8f93\u5165\u6846\uff1bTab \u586b\u5165\u6574\u53e5\uff0cCtrl+\u53f3\u65b9\u5411\u952e\u53ea\u586b\u4e0b\u4e00\u4e2a\u8bcd\uff0c\u90fd\u4e0d\u4f1a\u53d1\u9001\u3002",
      "manualPaused": "\u9884\u6d4b\u5df2\u6682\u505c\uff0c\u6682\u505c\u7ed3\u675f\u540e\u53ef\u7ee7\u7eed\u3002",
      "manualInputBusy": "\u8f93\u5165\u6846\u6b63\u5728\u5904\u7406\u6d88\u606f\u6216\u547d\u4ee4\uff0c\u8bf7\u7a0d\u5019\u3002",
      "manualRunning": "\u7b49\u5f85\u5f53\u524d\u56de\u5408\u7ed3\u675f\u540e\u518d\u9884\u6d4b\u3002",
      "manualDraft": "\u6e05\u7a7a\u8349\u7a3f\u540e\u53ef\u9884\u6d4b\u4e0b\u4e00\u53e5\uff1b\u8f93\u5165\u65f6\u4f7f\u7528\u5386\u53f2\u8865\u5168\u3002",
      "manualNoResult": "\u8fd9\u6b21\u6ca1\u6709\u751f\u6210\u65b0\u7684\u5efa\u8bae\uff0c\u53ef\u4ee5\u518d\u6b21\u9884\u6d4b\u3002",
      "manualNoRoute": "\u5f53\u524d\u6ca1\u6709\u53ef\u7528\u7684\u6a21\u578b\u8def\u7531\uff0c\u8bf7\u5728\u8bbe\u7f6e\u4e2d\u68c0\u67e5\u670d\u52a1\u5546\u548c\u6a21\u578b\u3002",
      "manualDisabled": "\u4e0b\u4e00\u53e5\u5efa\u8bae\u5df2\u5173\u95ed\u3002",
      "noHistory": "\u8fd8\u6ca1\u6709\u53ef\u53c2\u8003\u7684\u5bf9\u8bdd\uff0c\u8bf7\u5148\u53d1\u9001\u4e00\u6761\u6d88\u606f\u3002",
      "timeout": "\u9884\u6d4b\u8d85\u65f6\uff0c\u53ef\u4ee5\u624b\u52a8\u91cd\u8bd5\u3002",
      "manualBusy": "\u9884\u6d4b\u4e2d\u2026",
      "paused": "\u5df2\u6682\u505c",
      "pausedHint": "\u9884\u6d4b\u5df2\u6682\u505c\uff0c\u5230\u70b9\u81ea\u52a8\u6062\u590d\u3002",
      "empty": "\u6682\u65e0\u5efa\u8bae",
      "failed": "\u6ca1\u9884\u6d4b\u51fa\u6765",
      "hintTab": "Tab \u586b\u5165\u6574\u53e5\uff1bCtrl+\u53f3\u65b9\u5411\u952e\u53ea\u586b\u4e0b\u4e00\u4e2a\u8bcd\uff1b\u90fd\u4e0d\u4f1a\u53d1\u9001",
      "tabAccept": "Tab \u91c7\u7eb3",
      "settingsNav": "\u4e0b\u4e00\u53e5\u5efa\u8bae",
      "settingsTitle": "\u4e0b\u4e00\u53e5\u5efa\u8bae",
      "settingsIntro": "\u56de\u5408\u7ed3\u675f\u540e\u9884\u6d4b\u4f60\u7684\u4e0b\u4e00\u53e5\u8bdd\uff1b\u8f93\u5165\u8349\u7a3f\u65f6\u7528\u672c\u5730\u5386\u53f2\u505a\u524d\u7f00\u8865\u5168\u3002\u6253\u5b57\u4ecd\u662f\u9884\u6d4b\u5f00\u5934\u65f6\u7070\u5b57\u4f1a\u8ddf\u7740\u8d70\u3002Tab \u586b\u5165\u6574\u53e5\uff0cCtrl+\u53f3\u65b9\u5411\u952e\u53ea\u586b\u4e0b\u4e00\u4e2a\u8bcd\uff0c\u90fd\u4e0d\u4f1a\u81ea\u52a8\u53d1\u9001\u3002",
      "settingsEnabled": "\u542f\u7528\u5efa\u8bae",
      "settingsEnabledHint": "\u5173\u95ed\u540e\u65e2\u4e0d\u518d\u9884\u6d4b\uff0c\u4e5f\u4e0d\u518d\u663e\u793a\u5386\u53f2\u8865\u5168\u3002",
      "settingsMode": "\u9884\u6d4b\u65f6\u673a",
      "settingsModeHint": "\u81ea\u52a8\uff1a\u6bcf\u8f6e\u56de\u7b54\u7ed3\u675f\u540e\u9884\u6d4b\uff0c\u5931\u8d25\u6700\u591a\u91cd\u8bd5\u4e00\u6b21\u3002\u624b\u52a8\uff1a\u70b9\u51fb\u8f93\u5165\u6846\u4e0b\u65b9\u7684\u300c\u9884\u6d4b\u4e0b\u4e00\u53e5\u300d\u624d\u8c03\u7528\u6a21\u578b\u3002\u6bcf\u6b21\u8c03\u7528\u90fd\u53ef\u80fd\u8ba1\u8d39\u3002",
      "settingsModeAuto": "\u81ea\u52a8",
      "settingsModeManual": "\u4ec5\u624b\u52a8",
      "settingsMaxChars": "\u5efa\u8bae\u5b57\u6570\u4e0a\u9650",
      "settingsMaxCharsHint": "\u5efa\u8bae\u6700\u957f\u591a\u5c11\u4e2a\u5b57\u7b26\u3002\u4e2d\u6587\u6309\u5b57\uff0c\u82f1\u6587\u6309\u5b57\u7b26\u3002",
      "settingsContextMessages": "\u53c2\u8003\u6d88\u606f\u6761\u6570",
      "settingsContextMessagesHint": "\u9884\u6d4b\u65f6\u6700\u591a\u8bfb\u53d6\u6700\u8fd1\u591a\u5c11\u6761\u6d88\u606f\u3002",
      "settingsContextChars": "\u4e0a\u4e0b\u6587\u9884\u7b97",
      "settingsContextCharsHint": "\u8fd9\u4e9b\u6d88\u606f\u5408\u8ba1\u6700\u591a\u591a\u5c11\u4e2a\u5b57\u7b26\u3002",
      "settingsTimeout": "\u8d85\u65f6\uff08\u6beb\u79d2\uff09",
      "settingsTimeoutHint": "\u8d85\u65f6\u540e\u505c\u6b62\u7b49\u5f85\u5e76\u4e22\u5f03\u8fdf\u5230\u7ed3\u679c\u3002\u81ea\u52a8\u6a21\u5f0f\u6700\u591a\u91cd\u8bd5\u4e00\u6b21\uff1b\u624b\u52a8\u6a21\u5f0f\u663e\u793a\u539f\u56e0\uff0c\u7531\u4f60\u518d\u6b21\u70b9\u51fb\u3002",
      "settingsHistory": "\u5386\u53f2\u524d\u7f00\u8865\u5168",
      "settingsHistoryHint": "\u8f93\u5165\u65f6\u7528\u672c\u4f1a\u8bdd\u5df2\u53d1\u8fc7\u7684\u6d88\u606f\u505a\u7070\u5b57\u8865\u5168\uff0c\u4e0d\u4ea7\u751f\u4efb\u4f55\u6a21\u578b\u8c03\u7528\u3002",
      "settingsHistoryMinChars": "\u6700\u5c11\u8f93\u5165\u5b57\u6570",
      "settingsHistoryMinCharsHint": "\u8f93\u5165\u5230\u8fd9\u4e48\u591a\u4e2a\u5b57\u624d\u5f00\u59cb\u8865\u5168\u3002",
      "settingsProvider": "\u9884\u6d4b\u670d\u52a1\u5546",
      "settingsProviderHint": "\u586b\u5199\u670d\u52a1\u5546 ID\uff0c\u4e0e\u4e0b\u65b9\u6a21\u578b\u4e00\u8d77\u4fdd\u5b58\uff1b\u4e24\u9879\u7559\u7a7a\u5219\u4e0d\u53d1\u8d77\u9884\u6d4b\u3002",
      "settingsSaveRoute": "\u4fdd\u5b58\u9884\u6d4b\u6a21\u578b",
      "settingsRouteHint": "\u670d\u52a1\u5546\u548c\u6a21\u578b\u7f16\u8f91\u5b8c\u6210\u540e\uff0c\u70b9\u6b64\u4e00\u8d77\u4fdd\u5b58\u3002",
      "settingsRouteIncomplete": "\u8bf7\u586b\u5199\u670d\u52a1\u5546\u548c\u6a21\u578b\uff0c\u6216\u540c\u65f6\u6e05\u7a7a\u4e24\u9879\u4ee5\u5173\u6389\u9884\u6d4b\u3002",
      "settingsInherit": "\u4e0d\u9884\u6d4b",
      "settingsModel": "\u6a21\u578b",
      "settingsModelHint": "\u53ea\u5728\u9700\u8981\u6362\u5230\u66f4\u4fbf\u5b9c\u7684\u6a21\u578b\u65f6\u8bbe\u7f6e\u3002",
      "settingsPause": "\u6682\u505c\u5341\u5206\u949f",
      "settingsPauseHint": "\u6682\u505c\u671f\u95f4\u4e0d\u53d1\u8d77\u4efb\u4f55\u9884\u6d4b\u8c03\u7528\uff0c\u5230\u70b9\u81ea\u52a8\u6062\u590d\u3002",
      "settingsResume": "\u6062\u590d\u9884\u6d4b",
      "settingsResumeHint": "\u5f53\u524d\u5904\u4e8e\u6682\u505c\u72b6\u6001\uff0c\u70b9\u6b64\u7acb\u5373\u6062\u590d\u3002",
      "settingsReset": "\u6062\u590d\u9ed8\u8ba4",
      "settingsResetHint": "\u628a\u6240\u6709\u8bbe\u7f6e\u6062\u590d\u4e3a\u9ed8\u8ba4\u503c\u3002",
      "settingsSave": "\u4fdd\u5b58",
      "settingsUnsaved": "\u6709\u672a\u4fdd\u5b58\u7684\u7f16\u8f91",
      "settingsUncertain": "\u4fdd\u5b58\u7ed3\u679c\u5f85\u6838\u5bf9\uff1b\u540e\u7eed\u4fdd\u5b58\u5df2\u6682\u505c\u3002\u8bf7\u91cd\u65b0\u8bfb\u53d6\u8bbe\u7f6e\u540e\u518d\u64cd\u4f5c\u3002",
      "settingsReload": "\u91cd\u65b0\u8bfb\u53d6\u8bbe\u7f6e",
      "settingsReloading": "\u6b63\u5728\u8bfb\u53d6\u8bbe\u7f6e\u2026",
      "settingsEditHint": "\u6570\u503c\u7f16\u8f91\u5b8c\u6210\u540e\u79fb\u5f00\u7126\u70b9\u6216\u6309 Enter \u4fdd\u5b58\uff1bEsc \u64a4\u9500\u3002\u9884\u6d4b\u670d\u52a1\u5546\u548c\u6a21\u578b\u4f7f\u7528\u4e0b\u65b9\u6309\u94ae\u4e00\u8d77\u4fdd\u5b58\u3002",
      "settingsSaved": "\u5df2\u4fdd\u5b58",
      "settingsSaving": "\u6b63\u5728\u4fdd\u5b58\u2026",
      "settingsFailed": "\u4fdd\u5b58\u5931\u8d25",
      "settingsLoadFailed": "\u8bfb\u53d6\u8bbe\u7f6e\u5931\u8d25\uff0c\u5f53\u524d\u663e\u793a\u7684\u662f\u9ed8\u8ba4\u503c\u3002",
      "costWarning": "\u6bcf\u6b21\u81ea\u52a8\u9884\u6d4b\u90fd\u662f\u4e00\u6b21\u771f\u5b9e\u8ba1\u8d39\u7684\u6a21\u578b\u8c03\u7528\u3002",
      "never": "\u4ece\u4e0d",
    };

    const en = {
      "title": "Next-say suggestions",
      "idle": "Next-say",
      "tab": "Tab",
      "accept": "Accept",
      "reroll": "Another",
      "dismiss": "Dismiss",
      "thinking": "Thinking of your next message\u2026",
      "manual": "Predict",
      "manualPredict": "Predict next message",
      "manualHint": "Predict your next message. Suggestions only fill the draft; they never send.",
      "manualReady": "Suggestion shown in the editor. Tab fills all of it; Ctrl/Cmd+Right fills the next word. Neither sends.",
      "manualPaused": "Predictions are paused until the pause expires.",
      "manualInputBusy": "The editor is processing a message or command. Please wait.",
      "manualRunning": "Wait for the current turn to finish before predicting.",
      "manualDraft": "Clear the draft to predict. Typing uses history completion.",
      "manualNoResult": "No new suggestion this time. You can predict again.",
      "manualNoRoute": "No model route is available. Check the provider and model in settings.",
      "manualDisabled": "Next-say suggestions are disabled.",
      "noHistory": "No conversation to reference yet. Send a message first.",
      "timeout": "The prediction timed out. You can retry manually.",
      "manualBusy": "Predicting\u2026",
      "paused": "Paused",
      "pausedHint": "Predictions are paused and resume automatically.",
      "empty": "No suggestion yet",
      "failed": "Could not predict",
      "hintTab": "Tab fills the whole suggestion; Ctrl/Cmd+Right fills the next word; neither sends",
      "tabAccept": "Tab accept",
      "settingsNav": "Next-say",
      "settingsTitle": "Next-say suggestions",
      "settingsIntro": "Predicts your next message after each finished turn, and completes a draft from local history. Typing a matching prefix keeps the rest visible. Tab fills the whole suggestion; Ctrl/Cmd+Right fills the next word. Neither sends.",
      "settingsEnabled": "Enable suggestions",
      "settingsEnabledHint": "Turning this off stops both model predictions and history completion.",
      "settingsMode": "When to predict",
      "settingsModeHint": "Auto predicts after a finished turn, with at most one retry after failure. Manual calls the model only when you click Predict next message below the editor. Each call may be billed.",
      "settingsModeAuto": "Automatic",
      "settingsModeManual": "Manual only",
      "settingsMaxChars": "Suggestion length",
      "settingsMaxCharsHint": "Longest suggested message, in characters.",
      "settingsContextMessages": "Messages considered",
      "settingsContextMessagesHint": "How many recent messages a prediction may read.",
      "settingsContextChars": "Context budget",
      "settingsContextCharsHint": "Character cap across those messages.",
      "settingsTimeout": "Timeout (ms)",
      "settingsTimeoutHint": "A timeout stops waiting and discards late results. Auto mode retries at most once; manual mode shows the reason and waits for another click.",
      "settingsHistory": "History completion",
      "settingsHistoryHint": "Completes from messages already sent in this conversation. Makes no model call.",
      "settingsHistoryMinChars": "Minimum draft length",
      "settingsHistoryMinCharsHint": "How many characters to type before completion starts.",
      "settingsProvider": "Prediction provider",
      "settingsProviderHint": "Enter the provider ID and save it with the model below. Leave both empty to skip prediction.",
      "settingsSaveRoute": "Save prediction model",
      "settingsRouteHint": "Finish editing the provider and model, then save them together.",
      "settingsRouteIncomplete": "Fill in both provider and model, or clear both to turn prediction off.",
      "settingsInherit": "No prediction",
      "settingsModel": "Model",
      "settingsModelHint": "Set this only to move predictions to a cheaper model.",
      "settingsPause": "Pause for ten minutes",
      "settingsPauseHint": "No prediction call is made while paused; it resumes automatically.",
      "settingsResume": "Resume predictions",
      "settingsResumeHint": "Predictions are paused right now; press to resume immediately.",
      "settingsReset": "Reset to defaults",
      "settingsResetHint": "Restore every setting to its default value.",
      "settingsSave": "Save",
      "settingsUnsaved": "Unsaved edits",
      "settingsUncertain": "The save outcome needs checking. Further saves are paused; reload the settings before continuing.",
      "settingsReload": "Reload settings",
      "settingsReloading": "Reading settings...",
      "settingsEditHint": "Finish numeric edits by leaving the field or pressing Enter; Escape cancels. Save the prediction provider and model together with the button below.",
      "settingsSaved": "Saved",
      "settingsSaving": "Saving\u2026",
      "settingsFailed": "Could not save",
      "settingsLoadFailed": "Could not read the settings; showing defaults.",
      "costWarning": "Every automatic prediction is a real, billed model call.",
      "never": "Never",
    };

    const LOCALES = { zh, en };
    const KEY_COUNT = 74;

        /** Full-width and ASCII variants are unified before matching, never for display. */
    const NORMALIZE_STRIP = /[\s\u3000]+/g;

    /**
     * Bounded memo for normalizeForMatch.
     *
     * historyCompletion runs on every keystroke and normalizes every history
     * candidate; those candidate strings do not change between keystrokes, so
     * re-normalizing them 200x per keypress is pure waste. Keyed by the raw string
     * (results are pure), FIFO-evicted so it can never grow without bound.
     */
    const NORMALIZE_CACHE = new Map();
    const NORMALIZE_CACHE_LIMIT = 1024;

    /**
     * Comparison key for a draft or candidate.
     *
     * Width, case and internal whitespace differences are typing accidents, so they
     * must not break a match. The returned string is only ever used for comparison;
     * the text shown to the user is always the candidate's original bytes.
     */
    function normalizeForMatch(text) {
      const key = String(text ?? '');
      const hit = NORMALIZE_CACHE.get(key);
      if (hit !== undefined) return hit;
      const value = key
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
      if (NORMALIZE_CACHE.size >= NORMALIZE_CACHE_LIMIT) {
        const oldest = NORMALIZE_CACHE.keys().next().value;
        if (oldest !== undefined) NORMALIZE_CACHE.delete(oldest);
      }
      NORMALIZE_CACHE.set(key, value);
      return value;
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

    /** One ideograph is one accept step; everything else breaks on whitespace. */
    const CJK_CHAR = /^(?:[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])/u;

    function codeUnit(text, index) {
      return text.codePointAt(index) > 0xffff ? 2 : 1;
    }

    /**
     * How many characters of `suffix` one partial accept should take.
     *
     * Copilot / Continue accept the next word, not the whole ghost. Leading spaces
     * belong to that step (they only separate the caret from the word), then one
     * whitespace-delimited token, then its trailing space so the caret lands where
     * the next word starts. CJK has no spaces, so one ideograph is one step.
     *
     * @param {string} suffix Remainder still ghosted.
     * @returns {number} Character count, 0 when there is nothing to take.
     */
    function nextWordLength(suffix) {
      const text = String(suffix ?? '');
      if (text === '') return 0;
      let cursor = 0;
      while (cursor < text.length && /\s/u.test(String.fromCodePoint(text.codePointAt(cursor)))) {
        cursor += codeUnit(text, cursor);
      }
      if (cursor >= text.length) return cursor;
      const head = String.fromCodePoint(text.codePointAt(cursor));
      if (CJK_CHAR.test(head)) return cursor + head.length;
      while (cursor < text.length && !/\s/u.test(String.fromCodePoint(text.codePointAt(cursor)))) {
        cursor += codeUnit(text, cursor);
      }
      if (cursor < text.length && /\s/u.test(String.fromCodePoint(text.codePointAt(cursor)))) {
        cursor += codeUnit(text, cursor);
      }
      return cursor;
    }

    /**
     * The typed draft already ends with the gap, so the ghost must not draw it again.
     *
     * @param {string} draft
     * @param {string} suffix
     * @returns {string}
     */
    function dropRepeatedGap(draft, suffix) {
      if (suffix === '' || !/\s$/u.test(draft) || !/^\s/u.test(suffix)) return suffix;
      return suffix.replace(/^\s+/u, '');
    }

    /**
     * Remainder of `suggestion` after the user has already typed its opening.
     *
     * Mature composer plugins (dsh-ghost-prompt, Copilot ghost text) keep the
     * suggestion visible while the draft is still a prefix of it, and only hide it
     * when the typed text diverges. Width and case are typing accidents, so they
     * use the same comparison key as history completion; the returned slice is
     * always the suggestion's original characters.
     *
     * @param {string} suggestion Full predicted message.
     * @param {string} draft What is currently in the composer.
     * @returns {string | null} Remainder, or null when the draft is not a prefix.
     */
    function suggestionRemainder(suggestion, draft) {
      const full = String(suggestion ?? '');
      const typed = String(draft ?? '');
      if (full === '' || typed.trim() === '') return null;
      const query = normalizeForMatch(typed);
      const normalized = normalizeForMatch(full);
      if (query === '' || !normalized.startsWith(query)) return null;
      let consumed = 0;
      let position = 0;
      for (const char of full) {
        if (consumed >= query.length) break;
        consumed += normalizeForMatch(char).length;
        position += char.length;
      }
      if (consumed !== query.length) return null;
      const suffix = dropRepeatedGap(typed, full.slice(position));
      return suffix === '' ? null : suffix;
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

      let best = null;
      const items = Array.isArray(history) ? history.slice(-maxEntries) : [];
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        if (!item || typeof item.text !== 'string') continue;
        if (item.role !== undefined && item.role !== 'user' && !(includeAssistant && item.role === 'assistant')) continue;
        if (item.text.trim().length < 2) continue;
        const scored = scoreCandidate(item.text, query, recencyRank(index, items.length));
        if (scored === null || (best !== null && scored.score <= best.scored.score)) continue;

        // Only rank candidates that can actually be shown. A newer oversized tail
        // must not hide an older usable completion.
        let consumed = 0;
        let position = 0;
        for (const char of item.text) {
          if (consumed >= query.length) break;
          consumed += normalizeForMatch(char).length;
          position += char.length;
        }
        // Case folding can expand one character (for example U+0130). Matching only
        // half its normalized form cannot yield an append-only completion.
        if (consumed !== query.length) continue;
        const suffix = dropRepeatedGap(text, item.text.slice(position));
        if (suffix === '' || suffix.length > maxExtraChars) continue;
        best = { scored, suffix, full: item.text };
      }
      return best === null ? null : { suffix: best.suffix, full: best.full, source: 'history' };
    }

        const GHOST_ATTR = 'data-next-say-ghost';
    const STYLE_ID = 'next-say-ghost-style';
    const ghostDocuments = new WeakMap();
    let lastGhost = null;

    /** Host objects and test doubles must never control an unbounded loop. */
    function clearChildren(node) {
      const kids = node.children;
      if (kids != null && typeof kids.length === 'number') {
        const count = Number.isFinite(kids.length) ? Math.min(64, Math.max(0, Math.floor(kids.length))) : 64;
        for (let guard = 0; guard < count; guard += 1) {
          const index = Number.isFinite(kids.length) ? kids.length - 1 : 0;
          if (index < 0) return;
          node.removeChild(kids[index]);
        }
        return;
      }
      for (let guard = 0; guard < 64; guard += 1) {
        const child = node.firstChild;
        if (child == null) return;
        node.removeChild(child);
      }
    }

    function sessionKey(sessionId) {
      return sessionId == null ? '' : String(sessionId);
    }

    function ensureStyle(doc, owner) {
      if (owner.style !== null || doc.getElementById(STYLE_ID) != null) return;
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
      owner.style = style;
    }

    /** A missing scoped editor must never fall through into another conversation. */
    function findEditor(doc, sessionId) {
      const key = sessionKey(sessionId);
      if (key !== '') {
        // Escape CSS string syntax, including backslashes and line breaks.
        const escaped = key.replace(/[\\"\n\r\f]/g, (char) => `\\${char.charCodeAt(0).toString(16)} `);
        const scoped = doc.querySelector(`[data-conversation-session="${escaped}"] [data-composer-input="true"]`);
        if (scoped != null) return scoped;
        if (doc.querySelector('[data-conversation-session]') != null) return null;
      }
      // Legacy hosts without conversation markers are supported only when unique.
      if (typeof doc.querySelectorAll !== 'function') return null;
      const editors = doc.querySelectorAll('[data-composer-input="true"]');
      return editors.length === 1 ? editors[0] : null;
    }

    function restorePlaceholder(state) {
      if (state.placeholder === null) return;
      state.placeholder.style.display = state.placeholderWas;
      state.placeholder = null;
      state.placeholderWas = '';
    }

    function hidePlaceholder(state) {
      const host = state.editor?.parentElement;
      const node = typeof host?.querySelector === 'function' ? host.querySelector('[data-composer-placeholder]') : null;
      if (state.placeholder === node) return;
      restorePlaceholder(state);
      if (node == null) return;
      state.placeholder = node;
      state.placeholderWas = node.style.display;
      node.style.display = 'none';
    }

    function releaseState(state) {
      restorePlaceholder(state);
      state.observer?.disconnect();
      state.observer = null;
      if (state.win !== null) {
        state.win.removeEventListener('resize', state.onMove, true);
        state.win.removeEventListener('scroll', state.onMove, true);
      }
      state.layer.remove();
      state.editor = null;
      if (lastGhost === state) lastGhost = null;
    }

    /** Remove only this document's resources, optionally restricted to one session. */
    function clearGhost(doc, sessionId) {
      if (doc == null) return;
      const owner = ghostDocuments.get(doc);
      if (owner === undefined) return;
      const keys = arguments.length < 2 ? [...owner.sessions.keys()] : [sessionKey(sessionId)];
      for (const key of keys) {
        const state = owner.sessions.get(key);
        if (state === undefined) continue;
        releaseState(state);
        owner.sessions.delete(key);
      }
      if (owner.sessions.size === 0) {
        owner.style?.remove();
        ghostDocuments.delete(doc);
      }
    }

    /** Re-resolve the editor and replace its observer when the host remounts it. */
    function place(doc, state) {
      const editor = findEditor(doc, state.key);
      const host = editor?.parentElement;
      if (host == null) {
        clearGhost(doc, state.key);
        return false;
      }
      if (state.editor !== editor) {
        restorePlaceholder(state);
        state.observer?.disconnect();
        state.observer = null;
        state.editor = editor;
        const Observer = doc.defaultView?.ResizeObserver ?? globalThis.ResizeObserver;
        if (typeof Observer === 'function') {
          state.observer = new Observer(state.onMove);
          state.observer.observe(editor);
        }
      }
      const layer = state.layer;
      if (layer.parentElement !== host) host.appendChild(layer);
      const hostRect = host.getBoundingClientRect();
      const rect = editor.getBoundingClientRect();
      const computed = doc.defaultView.getComputedStyle(editor);
      const padLeft = parseFloat(computed.paddingLeft) || 0;
      const padRight = parseFloat(computed.paddingRight) || 0;
      const padTop = parseFloat(computed.paddingTop) || 0;
      layer.style.left = `${rect.left - hostRect.left + padLeft}px`;
      layer.style.top = `${rect.top - hostRect.top + padTop}px`;
      layer.style.width = `${Math.max(60, rect.width - padLeft - padRight)}px`;
      for (const prop of ['fontFamily', 'fontSize', 'lineHeight', 'fontWeight', 'letterSpacing']) {
        layer.style[prop] = computed[prop];
      }
      if (layer.dataset.shown === '1') hidePlaceholder(state);
      return true;
    }

    /** Paint only the requested session, preserving the invisible typed prefix. */
    function paintGhost(doc, sessionId, text, options = {}) {
      if (doc == null) return;
      const key = sessionKey(sessionId);
      const editor = findEditor(doc, key);
      if (editor?.parentElement == null) {
        clearGhost(doc, key);
        return;
      }
      let owner = ghostDocuments.get(doc);
      if (owner === undefined) {
        owner = { sessions: new Map(), style: null };
        ghostDocuments.set(doc, owner);
      }
      // A unique unmarked legacy editor can change sessions, but has only one owner.
      for (const [otherKey, other] of owner.sessions) {
        if (otherKey !== key && (other.editor === editor || findEditor(doc, otherKey) === editor)) {
          releaseState(other);
          owner.sessions.delete(otherKey);
        }
      }
      let state = owner.sessions.get(key);
      if (state === undefined) {
        const layer = doc.createElement('div');
        layer.setAttribute(GHOST_ATTR, '');
        layer.setAttribute('aria-hidden', 'true');
        layer.dataset.session = key;
        layer.dataset.shown = '0';
        state = { key, layer, editor: null, observer: null, win: doc.defaultView ?? null,
          onMove: null, placeholder: null, placeholderWas: '' };
        state.onMove = () => {
          if (ghostDocuments.get(doc)?.sessions.get(key) === state) place(doc, state);
        };
        owner.sessions.set(key, state);
        state.win?.addEventListener('resize', state.onMove, true);
        state.win?.addEventListener('scroll', state.onMove, true);
      }
      ensureStyle(doc, owner);
      if (!place(doc, state)) return;
      lastGhost = state;
      const node = state.layer;
      clearChildren(node);
      if (text === '') {
        node.dataset.shown = '0';
        restorePlaceholder(state);
        return;
      }
      const prefix = typeof options.prefix === 'string' ? options.prefix : '';
      if (prefix !== '') {
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
      hidePlaceholder(state);
      node.dataset.shown = '1';
    }

    /** No arguments preserve the last-painted debug view; doc/session are optional. */
    function ghostState(doc, sessionId) {
      let state = lastGhost;
      if (doc != null) {
        const sessions = ghostDocuments.get(doc)?.sessions;
        state = sessions?.get(sessionKey(sessionId));
        if (arguments.length < 2 && sessions !== undefined) state = [...sessions.values()].at(-1);
      }
      return state == null ? null : { shown: state.layer.dataset.shown === '1', session: state.key };
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
      if (response.ok === false) throw Object.assign(new Error('request failed (' + response.status + ')'), { status: response.status });
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
      const body = await response.json();
      if (response.ok === false) throw Object.assign(new Error('request failed (' + response.status + ')'), { status: response.status });
      return body;
    }

    /** Bound read-only HTTP waits even when a carrier ignores cancellation. */
    async function getJsonBounded(path, signal) {
      const controller = new AbortController();
      let timer;
      const cancel = () => { clearTimeout(timer); controller.abort(signal && signal.reason); };
      let onAbort;
      signal?.addEventListener?.('abort', cancel, { once: true });
      try {
        if (signal && signal.aborted) cancel();
        controller.signal.throwIfAborted();
        const interrupted = new Promise((resolve, reject) => {
          onAbort = () => reject(controller.signal.reason);
          controller.signal.addEventListener('abort', onAbort, { once: true });
        });
        timer = setTimeout(() => controller.abort(new Error('read request timed out')), 10000);
        return await Promise.race([getJson(path, controller.signal), interrupted]);
      } finally {
        clearTimeout(timer);
        if (onAbort) controller.signal.removeEventListener('abort', onAbort);
        signal?.removeEventListener?.('abort', cancel);
      }
    }

    /**
     * Whether the caret is in the message editor.
     *
     * Tab must never be swallowed while the user is in another field (a search
     * box, a settings input): that would break ordinary focus movement.
     */
    function inComposer(sessionId) {
      const active = document.activeElement;
      if (!active || typeof active.closest !== 'function') return false;
      const editor = active.closest('[data-composer-input="true"]');
      if (!editor) return false;
      const conversation = editor.closest('[data-conversation-session]');
      return !conversation || conversation.getAttribute('data-conversation-session') === String(sessionId);
    }

    /** Shared settings snapshot, so the row and the settings page agree. */
    const settingsStore = {
      value: null,
      error: undefined,
      writeUncertain: false,
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

    const SETTINGS_TIMEOUT_MS = 10000;
    let settingsLoad = null;
    let settingsRevision = 0;
    let settingsQueueEpoch = 0;
    let settingsWrites = Promise.resolve();

    function uncertainSettingsError() {
      return Object.assign(new Error('settings require a fresh read'), { code: 'settings-uncertain' });
    }

    async function settingsRequest(payload) {
      const controller = new AbortController();
      let timer;
      try {
        const work = payload === undefined
          ? getJson('/settings', controller.signal)
          : postJson('/settings', payload, controller.signal);
        return await Promise.race([
          work,
          new Promise((resolve, reject) => {
            timer = setTimeout(() => {
              reject(Object.assign(new Error('settings request timed out'), { code: 'settings-timeout' }));
              controller.abort();
            }, SETTINGS_TIMEOUT_MS);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }

    function loadSettings() {
      if (settingsLoad !== null) return settingsLoad;
      const revision = settingsRevision;
      settingsLoad = (async () => {
        try {
          const body = await settingsRequest();
          if (!body || body.ok !== true || !body.settings) throw new Error('invalid settings response');
          if (revision === settingsRevision) {
            settingsStore.error = undefined;
            settingsStore.writeUncertain = false;
            settingsStore.set(body.settings);
          }
          return body.settings;
        } catch (error) {
          if (revision === settingsRevision) {
            settingsStore.error = error instanceof Error ? error.message : String(error);
            if (settingsStore.value === null) settingsStore.set({ ...DEFAULT_SETTINGS });
          }
          return undefined;
        } finally {
          settingsLoad = null;
        }
      })();
      return settingsLoad;
    }

    function saveSettings(patch) {
      // Serialize writes in user order. Cancelling an earlier HTTP request would
      // not undo its server-side write, so latest-response filtering alone fails.
      settingsRevision += 1;
      const payload = { ...patch };
      const epoch = settingsQueueEpoch;
      const write = settingsWrites.then(async () => {
        if (settingsStore.writeUncertain || epoch !== settingsQueueEpoch) throw uncertainSettingsError();
        let body;
        try {
          body = await settingsRequest(payload);
          if (!body || body.ok !== true || !body.settings) throw new Error('invalid settings response');
        } catch (error) {
          // Only explicit pre-write HTTP rejections prove that no setting was
          // changed. Disconnects, malformed replies and 5xx may follow a write.
          if (![400, 401, 403, 404, 405, 408, 413].includes(error && error.status)) {
            settingsStore.writeUncertain = true;
            settingsQueueEpoch += 1;
            settingsRevision += 1;
            throw uncertainSettingsError();
          }
          throw error;
        }
        settingsRevision += 1;
        settingsStore.error = undefined;
        settingsStore.set(body.settings);
        return body;
      });
      settingsWrites = write.catch(() => {});
      return write;
    }

    /**
     * The user's own messages in this conversation, for local completion.
     *
     * Fetched per session and refreshed after each finished turn; a keystroke
     * never hits the network.
     */
    function createHistoryCache() {
      const entries = new Map();
      const maxSessions = 16;
      const maxTotalChars = 1000000;
      let totalChars = 0;
      const forget = (sessionId) => {
        const entry = entries.get(sessionId);
        if (entry) totalChars -= entry.chars;
        entries.delete(sessionId);
      };
      const touch = (sessionId, entry) => {
        entries.delete(sessionId);
        entries.set(sessionId, entry);
        for (let guard = 0; guard <= maxSessions && (entries.size > maxSessions || totalChars > maxTotalChars); guard += 1) {
          forget(entries.keys().next().value);
        }
      };
      const store = (sessionId, entry, items) => {
        const kept = [];
        const source = Array.isArray(items) ? items : [];
        let chars = 0;
        for (let index = source.length - 1; index >= 0 && kept.length < 200; index -= 1) {
          const item = source[index];
          if (!item || typeof item.text !== 'string' || (item.role !== undefined && item.role !== 'user')) continue;
          const text = item.text.slice(0, 2000);
          if (text.trim() === '') continue;
          kept.push({ text, role: 'user' });
          chars += text.length;
        }
        totalChars += chars - entry.chars;
        entry.chars = chars;
        entry.items = kept.reverse();
        touch(sessionId, entry);
      };
      return {
        get(sessionId) {
          const entry = entries.get(sessionId);
          if (!entry) return undefined;
          touch(sessionId, entry);
          return entry.items;
        },
        set(sessionId, items) {
          const entry = entries.get(sessionId) || { items: [], chars: 0 };
          entry.revision = {};
          store(sessionId, entry, items);
        },
        async refresh(sessionId, signal) {
          if (!sessionId) return [];
          const entry = entries.get(sessionId) || { items: [], chars: 0 };
          const revision = {};
          entry.revision = revision;
          touch(sessionId, entry);
          try {
            const body = await getJsonBounded('/history?sessionId=' + encodeURIComponent(sessionId), signal);
            if (!body || body.ok === false || !Array.isArray(body.items)) throw new Error('invalid history response');
            // Identity matters as well as revision: eviction/clear must invalidate
            // an old request even if the same session is opened again later.
            if (!(signal && signal.aborted) && entries.get(sessionId) === entry && entry.revision === revision) {
              store(sessionId, entry, body && body.items);
            }
          } catch {
            // Keep the last successful pool when a refresh is cancelled or fails.
          }
          return entries.get(sessionId)?.items || [];
        },
        clear: forget,
      };
    }

    const historyCache = createHistoryCache();

    // Controls live in the allocated dock; their request owner remains the
    // corresponding overlay component. Unmounting one session cannot affect another.
    const manualControls = {
      entries: new Map(),
      listeners: new Set(),
      publish(sessionId, owner, value) {
        this.entries.set(sessionId, { ...value, owner });
        for (const listener of this.listeners) listener(sessionId);
      },
      remove(sessionId, owner) {
        if (this.entries.get(sessionId)?.owner !== owner) return;
        this.entries.delete(sessionId);
        for (const listener of this.listeners) listener(sessionId);
      },
      subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      },
    };

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
        // A stale callback must not call a controller replaced after session switch.
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
      const [manualMessage, setManualMessage] = React.useState('');

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
      const [suppressionEpoch, setSuppressionEpoch] = React.useState(0);
      const alive = React.useRef(true);
      const inFlight = React.useRef(null);
      const scope = React.useRef({ sessionId, historyController: null });
      const suggestionSession = React.useRef(sessionId);
      const lastPoolFetch = React.useRef(0);
      const triedOnMount = React.useRef(false);
      if (scope.current.sessionId !== sessionId) {
        scope.current = { sessionId };
        historyRef.current = [];
        dismissed.current = '';
        accepted.current = '';
        lastPoolFetch.current = 0;
        triedOnMount.current = false;
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

      // A new session is a new conversation: clear everything that belonged to
      // the old one instead of showing its suggestion under a different chat.
      React.useEffect(() => {
        dismissed.current = '';
        accepted.current = '';
        setSuggestion('');
        setSource('');
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

      // Recomputed on every draft change: a pure function over the cached
      // history, so this is a string scan, not a request.
      const local = React.useMemo(() => {
        if (!enabled || paused || !inputReady || settings === null || settings.historyEnabled !== true) return null;
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
      }, [enabled, settings, blankDraft, draft, historyEpoch, sessionId, suppressionEpoch, paused, inputReady]);

      /* -------------------------------------------- history pool lifecycle */

      // The pool is fetched once when the session changes, but that single fetch
      // races the composer: an empty answer then leaves completion permanently
      // dead, because nothing else refreshes it. Retry while the user is typing
      // and the pool is still empty, throttled so it cannot become a poll loop.
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
      }, [enabled, paused, settings, blankDraft, draft, historyEpoch, sessionId]);

      /* ------------------------------------------- model prediction on turn */

      // One attempt per composer mount, before any turn bookkeeping is involved.
      //
      // The turn feed is a derived signal and has already been wrong twice; this
      // guarantees that an idle, empty composer gets offered a suggestion on load
      // even if the feed says nothing. The Host still refuses to spend a second
      // call for a turn it has already predicted, so this cannot double-bill a
      // turn that was also predicted through the feed.
      React.useEffect(() => {
        if (!enabled || paused || sessionId === undefined || sessionId === null || sessionId === '') return undefined;
        if (settings === null || settings.mode !== 'auto' || !inputReady) return undefined;
        // An empty route means "do not predict". Asking anyway only learns no-route.
        if (typeof settings.provider !== 'string' || settings.provider.trim() === '' || typeof settings.model !== 'string' || settings.model.trim() === '') return undefined;
        if (running || !blankDraft) return undefined;
        if (suggestion !== '' || busy) return undefined;
        if (triedOnMount.current) return undefined;
        const timer = setTimeout(() => {
          if (!alive.current || scope.current !== currentScope) return;
          triedOnMount.current = true;
          void predict({ manual: false });
        }, 1200);
        return () => clearTimeout(timer);
        // `predict` is deliberately NOT a dependency: it is declared below this
        // effect, so naming it in the array would read it during render (TDZ) and
        // throw. The callback captured here is the one for this session, which is
        // exactly what an effect that runs once wants.
      }, [enabled, paused, sessionId, settings, running, blankDraft, suggestion, busy, inputReady]);

      // Poll the Host's turn feed rather than agent/status: status flips once
      // per step, so a tool-calling turn looks like many finished turns.
      React.useEffect(() => {
        if (!enabled || paused || sessionId === undefined || sessionId === null || sessionId === '') return undefined;
        if (settings === null || settings.mode !== 'auto' || !inputReady) return undefined;
        if (typeof settings.provider !== 'string' || settings.provider.trim() === '' || typeof settings.model !== 'string' || settings.model.trim() === '') return undefined;
        if (running) return undefined;
        if (!blankDraft) return undefined;
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
          try {
            // Read only: the Host marks a turn as spent inside /predict, so a
            // cancelled tick (a re-render while this request was in flight) can no
            // longer consume a turn that was never used.
            const body = await getJsonBounded('/turn?sessionId=' + encodeURIComponent(sessionId), controller.signal);
            if (body && body.ok !== false) {
              if (body.enabled === false) return;
              turn = body.turn;
              predicted = body.predicted === undefined ? null : body.predicted;
            }
          } catch {
            // A Host that is briefly unreachable is not an error worth showing.
          } finally {
            checking = false;
          }
          if (cancelled || !alive.current || hidden() || scope.current !== currentScope) return;
          const alreadyDone = predicted !== null && turn !== null && turn <= predicted;
          if (turn === null || turn === undefined || alreadyDone) {
            timer = setTimeout(tick, 2000);
            return;
          }
          void predict({ manual: false, turn });
        };

        // A hidden tab cannot show the ghost, so the 2s turn poll stops until
        // the page is visible again. Becoming visible checks immediately.
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
      }, [enabled, paused, sessionId, settings, running, blankDraft, suggestion, busy, inputReady]);

      /**
       * Ask the Host for a suggestion.
       *
       * `avoid` carries the current text so "another one" cannot come back with
       * the same sentence dressed differently.
       */
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
        let onAbort;
        const interrupted = new Promise((resolve, reject) => {
          onAbort = () => reject(controller.signal.reason);
          controller.signal.addEventListener('abort', onAbort, { once: true });
        });
        const budget = Math.max(2000, Math.min(60000, Number(settingsStore.value?.timeoutMs) || 12000)) + 10000;
        const deadline = setTimeout(() => controller.abort(Object.assign(new Error('prediction response timed out'), { code: 'client-timeout' })), budget);
        try {
          const body = await Promise.race([postJson('/predict', {
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
          }, controller.signal), interrupted]);
          if (!alive.current || controller.signal.aborted || scope.current !== currentScope || inFlight.current !== controller) return false;
          suggestionSession.current = sessionId;
          if (body && body.ok === true && typeof body.suggestion === 'string' && body.suggestion !== '') {
            // A prediction that merely repeats what is already in the composer is
            // worthless: accepting it would insert the sentence twice. This is
            // not hypothetical -- it was observed on screen, because a prediction
            // describes the user's NEXT message while the box may already hold
            // that very text.
            const trimmedDraft = draftRef.current.trim();
            const repeatsDraft = trimmedDraft !== '' && body.suggestion.trim() === trimmedDraft;
            if (repeatsDraft || body.suggestion === dismissed.current || body.suggestion === accepted.current) {
              if (manual) setManualMessage('manualNoResult');
              else { setSuggestion(''); setSource(''); }
              return false;
            }
            setSuggestion(body.suggestion);
            setSource('model');
            if (manual) setManualMessage('manualReady');
            const historySignal = currentScope.historyController.signal;
            void historyCache.refresh(sessionId, historySignal).then((items) => {
              if (!alive.current || historySignal.aborted || controller.signal.aborted || scope.current !== currentScope) return;
              historyRef.current = items;
              // A finished turn adds the user's own message to the pool, which
              // is exactly when a new completion becomes possible.
              setHistoryEpoch((value) => value + 1);
            });
            return true;
          }
          if (manual) {
            const key = { __proto__: null, 'no-history': 'noHistory', 'no-route': 'manualNoRoute', timeout: 'timeout',
              empty: 'manualNoResult', truncated: 'manualNoResult', 'repeats-draft': 'manualNoResult',
              paused: 'manualPaused', disabled: 'manualDisabled' }[body && body.reason] || 'failed';
            setManualMessage(key);
          } else { setSuggestion(''); setSource(''); }
          return false;
        } catch (error) {
          if (!alive.current || scope.current !== currentScope || inFlight.current !== controller) return false;
          if (controller.signal.aborted) {
            if (manual && controller.signal.reason?.code === 'client-timeout') setManualMessage('timeout');
          } else if (manual) setManualMessage('failed');
          return false;
        } finally {
          clearTimeout(deadline);
          controller.signal.removeEventListener('abort', onAbort);
          if (inFlight.current === controller) {
            inFlight.current = null;
            if (alive.current && scope.current === currentScope) setBusy(false);
          }
        }
      }, [sessionId]);

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

      /**
       * Fill the draft through the composer's own action.
       *
       * `captureInsertion()` returns the caret span with the draft revision it
       * was measured at; `insertText` refuses the write when the revision moved,
       * so text typed between reading and writing is never overwritten.
       */
      const accept = React.useCallback((text, partial) => {
        if (text === '' || !inputActions || !live.current.enabled || live.current.paused || !live.current.inputReady) return false;
        try {
          const span = inputActions.captureInsertion();
          if (!inputActions.insertText(text, span)) return false;
          // One word must leave the prediction in place. Clearing it here made
          // the rest of the ghost disappear, which is the opposite of
          // acceptNextWord. Only a full accept consumes the suggestion.
          if (partial === true) return true;
          accepted.current = draftRef.current + text;
          dismissed.current = '';
          setSuppressionEpoch((value) => value + 1);
          setSuggestion('');
          setSource('');
          return true;
        } catch {
          return false;
        }
      }, [inputActions]);

      const dismiss = React.useCallback(() => {
        // Remember WHAT was refused, not just "the draft": a dismissed model
        // suggestion must not come back, but a dismissed completion only covers
        // the exact draft it was offered for -- keep typing and it may offer
        // again. Recording the raw draft here suppressed every later completion
        // for the whole session.
        setSuppressionEpoch((value) => value + 1);
        dismissed.current = suggestionSession.current === sessionId && !running && suggestion !== '' && (blankDraft || suggestionRemainder(suggestion, draft) !== null)
          ? suggestion
          : `${draft}\u0000local`;
        setSuggestion('');
        setSource('');
      }, [suggestion, draft, sessionId, blankDraft, running]);

      /* ------------------------------------------------------------ render */

      // NOTE: no early `return` may appear above this point, and none may appear
      // between two hook calls. `enabled` flips from false to true when the
      // settings arrive; returning early on the false pass would make this
      // component render FEWER hooks than the next pass, and React throws
      // "Rendered more hooks than during the previous render". That crash is
      // swallowed by the slot renderer -- the composer simply stayed empty with
      // no visible error. The disabled case is handled inside the paint effect.

      // Two sources, one paint rule (dsh-ghost-prompt / Copilot ghost text):
      //   - a model prediction is the WHOLE next message. While the draft is
      //     still a prefix of it, only the remainder stays visible; a divergent
      //     draft hides it, and clearing the box brings the whole message back.
      //     Hiding on the first keystroke made a usable prediction vanish the
      //     moment the user started agreeing with it.
      //   - a history completion supplies only the remainder of an earlier
      //     message. It yields to a still-matching prediction so the two ghosts
      //     never stack.
      // Showing a completion's full text next to a draft it starts with looks
      // like the draft being repeated, and accepting it would insert the
      // sentence twice.
      const modelLive = suggestion !== '' && suggestionSession.current === sessionId && suggestion !== dismissed.current && !running;
      const modelFollows = !modelLive || blankDraft ? null : suggestionRemainder(suggestion, draft);
      const modelText = !modelLive
        ? ''
        : (blankDraft ? suggestion : (modelFollows === null ? '' : modelFollows));
      const localSuffix = modelText !== '' || local === null ? '' : local.suffix;

      // What one paint should show.
      //
      // An empty composer paints the whole prediction at the origin. Any other
      // suggestion is ONLY the remainder, preceded by the typed draft as
      // invisible text so it starts exactly after it. Painting `draft +
      // remainder` as visible text double-drew the user's own characters.
      const ghostText = modelText !== '' ? modelText : localSuffix;
      const ghostPrefix = ghostText !== '' && !blankDraft ? draft : '';

      /**
       * Insert exactly the remainder that is on screen.
       *
       * Tab takes all of it. A partial accept (Ctrl/Cmd+Right, same idea as
       * Copilot acceptNextWord and Continue) takes one word and leaves the
       * ghost continuing after the caret. A model remainder and a history
       * suffix both go through this, so the two cannot drift.
       */
      const acceptSuggested = React.useCallback((wordOnly) => {
        const offered = modelText !== '' ? modelText : localSuffix;
        if (offered === '') return false;
        const count = wordOnly === true ? nextWordLength(offered) : offered.length;
        const piece = count >= offered.length ? offered : offered.slice(0, count);
        return accept(piece, piece.length < offered.length);
      }, [accept, modelText, localSuffix]);

      // Keyboard: Tab accepts the whole remainder, Ctrl/Cmd+Right accepts the
      // next word, Escape dismisses. Only from the composer, and only while a
      // suggestion is actually on screen -- anywhere else Tab keeps its meaning.
      React.useEffect(() => {
        if (typeof document === 'undefined') return undefined;
        const onKeyDown = (event) => {
          if (event.defaultPrevented || event.isComposing) return;
          if (!enabled || paused || !inputReady || !live.current.inputReady || scope.current !== currentScope) return;
          if (modelText === '' && local === null) return;
          if (!inComposer(sessionId)) return;
          if (event.key === 'Tab' && event.shiftKey !== true && event.ctrlKey !== true && event.metaKey !== true && event.altKey !== true) {
            if (acceptSuggested(false)) {
              event.preventDefault();
              event.stopPropagation();
            }
            return;
          }
          // Copilot / Continue: accept only the next word, leaving the caret
          // where the rest of the ghost continues. Ctrl on Windows, Cmd on macOS.
          if (event.key === 'ArrowRight' && event.altKey !== true && event.shiftKey !== true && (event.ctrlKey === true || event.metaKey === true)) {
            if (acceptSuggested(true)) {
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
      }, [acceptSuggested, dismiss, local, modelText, enabled, paused, inputReady, sessionId]);

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
        if (!enabled || paused) {
          clearGhost(document, sessionId);
          return undefined;
        }
        if (!inputReady) {
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
      }, [enabled, paused, inputReady, sessionId, ghostText, ghostPrefix]);

      // Leaving this session, or unmounting, must not leave stale ghost text
      // floating over an empty composer.
      React.useEffect(() => () => {
        if (typeof document !== "undefined") clearGhost(document, sessionId);
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
      if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'object') return DEFAULT_SETTINGS[key];
      if (typeof value === 'string' && value.trim() === '') return DEFAULT_SETTINGS[key];
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
      const [edits, setEdits] = React.useState({});
      const editsRef = React.useRef({});
      const editVersions = React.useRef({});
      const saveRevision = React.useRef(0);
      const alive = React.useRef(true);

      React.useEffect(() => {
        alive.current = true;
        return () => { alive.current = false; };
      }, []);

      React.useEffect(() => settingsStore.subscribe(() => setValue(settingsStore.value)), []);
      React.useEffect(() => {
        if (settingsStore.value === null) void loadSettings();
      }, []);

      const save = React.useCallback(async (patch) => {
        const revision = ++saveRevision.current;
        setStatus('saving');
        try {
          await saveSettings(patch);
          if (alive.current && revision === saveRevision.current) setStatus('saved');
          return true;
        } catch (error) {
          if (alive.current && revision === saveRevision.current) setStatus(error && error.code === 'settings-uncertain' ? 'uncertain' : 'failed');
          return false;
        }
      }, []);

      const reloadSettings = async () => {
        if (status === 'saving' || status === 'loading') return;
        const revision = ++saveRevision.current;
        setStatus('loading');
        const loaded = await loadSettings();
        if (!alive.current || revision !== saveRevision.current) return;
        setStatus(settingsStore.writeUncertain ? 'uncertain' : loaded ? 'saved' : 'failed');
      };
      const current = value || DEFAULT_SETTINGS;
      const editField = (key, text) => {
        editVersions.current = { ...editVersions.current, [key]: {} };
        editsRef.current = { ...editsRef.current, [key]: text };
        setEdits(editsRef.current);
      };
      const clearSavedEdits = (snapshot, versions = editVersions.current) => {
        if (!alive.current) return;
        const next = { ...editsRef.current };
        for (const [key, text] of Object.entries(snapshot)) {
          if (next[key] === text && editVersions.current[key] === versions[key]) delete next[key];
        }
        editsRef.current = next;
        setEdits(next);
      };
      const fieldText = (key) => Object.hasOwn(edits, key) ? edits[key] : String(current[key] ?? '');
      const commitNumber = async (key) => {
        if (!Object.hasOwn(editsRef.current, key)) return;
        const text = editsRef.current[key];
        const versions = editVersions.current;
        if (await save({ [key]: clampTo(key, text) })) clearSavedEdits({ [key]: text }, versions);
      };
      const providerText = fieldText('provider');
      const modelText = fieldText('model');
      const routeComplete = (providerText.trim() === '') === (modelText.trim() === '');
      const routeChanged = providerText.trim() !== current.provider || modelText.trim() !== current.model;
      const commitRoute = async () => {
        const snapshot = {
          provider: Object.hasOwn(editsRef.current, 'provider') ? editsRef.current.provider : current.provider,
          model: Object.hasOwn(editsRef.current, 'model') ? editsRef.current.model : current.model,
        };
        const versions = editVersions.current;
        if ((snapshot.provider.trim() === '') !== (snapshot.model.trim() === '')) return;
        if (await save({ provider: snapshot.provider.trim(), model: snapshot.model.trim() })) clearSavedEdits(snapshot, versions);
      };
      const paused = isPaused(current, now);
      // The countdown is the only consumer of `now`. An open settings page that
      // is not paused must not re-render once a second for as long as it stays
      // mounted. The effect sits after `paused` so the interval tracks that
      // boolean; other hooks stay above it and keep a stable order.
      React.useEffect(() => {
        if (!paused) return undefined;
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
      }, [paused]);
      const remaining = paused ? Math.max(0, Math.ceil((Number(current.pausedUntil) - now) / 1000)) : 0;
      const countdown = remaining >= 60
        ? `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`
        : String(remaining);

      const toggle = (key) => (event) => { void save({ [key]: event.target.checked }); };
      const number = (key, min, max, label) => h('input', {
        type: 'number',
        min,
        max,
        'aria-label': t(label),
        style: inputStyle,
        value: fieldText(key),
        // Preserve transient empty and out-of-range input until editing ends.
        onChange: (event) => editField(key, event.target.value),
        onBlur: () => { void commitNumber(key); },
        onKeyDown: (event) => {
          if (event.isComposing) return;
          if (event.key === 'Enter') {
            event.preventDefault();
            event.currentTarget.blur();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            clearSavedEdits({ [key]: editsRef.current[key] });
          }
        },
      });
      const select = (key, options) => h('select', {
        'aria-label': t('settingsMode'),
        style: inputStyle,
        value: current[key],
        onChange: (event) => { void save({ [key]: event.target.value }); },
      }, options.map((option) => h('option', { key: option.value, value: option.value }, t(option.label))));

      return h('div', { style: { padding: '4px 0 24px' } },
        h('h2', { style: { fontSize: 16, margin: '0 0 6px' } }, t('settingsTitle')),
        h('p', { style: { fontSize: 12, margin: '0 0 4px', ...hintStyle } }, t('settingsIntro')),
        h('p', { style: { fontSize: 12, margin: '0 0 8px', ...hintStyle } }, t('costWarning')),
        h('p', { style: { ...hintStyle, margin: '0 0 16px' } }, t('settingsEditHint')),

        settingsStore.error === undefined ? null : h('p', {
          style: { fontSize: 12, margin: '0 0 16px', color: 'var(--dsw-alias-state-warning-primary, #b45309)' },
        }, t('settingsLoadFailed')),

        h('div', { style: rowStyle },
          h('div', null, h('div', { style: labelStyle }, t('settingsEnabled')), h('div', { style: hintStyle }, t('settingsEnabledHint'))),
          h('input', { type: 'checkbox', 'aria-label': t('settingsEnabled'), checked: current.enabled === true, onChange: toggle('enabled') })),

        h('div', { style: rowStyle },
          h('div', null, h('div', { style: labelStyle }, t('settingsMode')), h('div', { style: hintStyle }, t('settingsModeHint'))),
          select('mode', [
            { value: 'auto', label: 'settingsModeAuto' },
            { value: 'manual', label: 'settingsModeManual' },
          ])),

        h('div', { style: rowStyle },
          h('div', null, h('div', { style: labelStyle }, t('settingsMaxChars')), h('div', { style: hintStyle }, t('settingsMaxCharsHint'))),
          number('maxSuggestionChars', 20, 400, 'settingsMaxChars')),

        h('div', { style: rowStyle },
          h('div', null, h('div', { style: labelStyle }, t('settingsContextMessages')), h('div', { style: hintStyle }, t('settingsContextMessagesHint'))),
          number('contextMessages', 2, 20, 'settingsContextMessages')),

        h('div', { style: rowStyle },
          h('div', null, h('div', { style: labelStyle }, t('settingsContextChars')), h('div', { style: hintStyle }, t('settingsContextCharsHint'))),
          number('contextChars', 1000, 20000, 'settingsContextChars')),

        h('div', { style: rowStyle },
          h('div', null, h('div', { style: labelStyle }, t('settingsTimeout')), h('div', { style: hintStyle }, t('settingsTimeoutHint'))),
          number('timeoutMs', 2000, 60000, 'settingsTimeout')),

        h('div', { style: rowStyle },
          h('div', null, h('div', { style: labelStyle }, t('settingsHistory')), h('div', { style: hintStyle }, t('settingsHistoryHint'))),
          h('input', { type: 'checkbox', 'aria-label': t('settingsHistory'), checked: current.historyEnabled === true, onChange: toggle('historyEnabled') })),

        h('div', { style: rowStyle },
          h('div', null, h('div', { style: labelStyle }, t('settingsHistoryMinChars')), h('div', { style: hintStyle }, t('settingsHistoryMinCharsHint'))),
          number('historyMinChars', 1, 8, 'settingsHistoryMinChars')),

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
            'aria-label': t('settingsProvider'),
            'aria-describedby': 'next-say-route-hint',
            'aria-invalid': !routeComplete,
            value: providerText,
            onChange: (event) => editField('provider', event.target.value),
          })),

        h('div', { style: { ...rowStyle, borderBottom: 'none' } },
          h('div', null, h('div', { style: labelStyle }, t('settingsModel')), h('div', { style: hintStyle }, t('settingsModelHint'))),
          h('input', {
            type: 'text',
            style: { ...inputStyle, minWidth: 180 },
            placeholder: current.model === '' ? t('settingsInherit') : '',
            'aria-label': t('settingsModel'),
            'aria-describedby': 'next-say-route-hint',
            'aria-invalid': !routeComplete,
            value: modelText,
            onChange: (event) => editField('model', event.target.value),
          })),

        h('div', { style: rowStyle },
          h('p', { id: 'next-say-route-hint', style: { ...hintStyle, margin: 0 } }, t(routeComplete ? 'settingsRouteHint' : 'settingsRouteIncomplete')),
          h('button', {
            type: 'button',
            style: { ...inputStyle, cursor: routeChanged && routeComplete ? 'pointer' : 'default' },
            disabled: !routeChanged || !routeComplete || settingsStore.writeUncertain,
            'aria-describedby': 'next-say-route-hint',
            onClick: () => { void commitRoute(); },
          }, t('settingsSaveRoute'))),

        h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, paddingTop: 14 } },
          h('button', {
            type: 'button',
            style: { ...inputStyle, cursor: 'pointer' },
            disabled: settingsStore.writeUncertain,
            onClick: () => {
              editsRef.current = {};
              editVersions.current = {};
              setEdits({});
              void save({ reset: true });
            },
          }, t('settingsReset')),
          h('span', { style: hintStyle }, t('settingsResetHint')),
          h('span', { role: 'status', 'aria-live': 'polite', style: hintStyle }, settingsStore.writeUncertain ? t('settingsUncertain') : status === 'loading' ? t('settingsReloading') : status === 'saving' ? t('settingsSaving') : status === 'failed' ? t('settingsFailed') : Object.keys(edits).length > 0 ? t('settingsUnsaved') : status === 'saved' ? t('settingsSaved') : ''),
          settingsStore.writeUncertain || settingsStore.error !== undefined ? h('button', {
            type: 'button', style: { ...inputStyle, cursor: 'pointer' },
            disabled: status === 'loading' || status === 'saving',
            onClick: () => { void reloadSettings(); },
          }, t('settingsReload')) : null),
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

      ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
        name: 'conversation.composer.dock',
        id: 'next-say-manual',
        order: 20,
        locale: NS,
      }, ManualControl));

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
        ManualControl,
        manualControls,
        settingsStore,
        createHistoryCache,
        loadSettings,
        saveSettings,
        SettingsPage,
      },
    };
    return moduleExports;
  },
});
