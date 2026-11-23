/**
 * Local history prefix completion for dsh-plugin-next-say.
 *
 * This is the zero-cost half of the plugin: while the user is typing, the
 * suggestion comes from messages they already sent in this conversation, so no
 * model call is made and the answer is instant. It behaves like zsh
 * autosuggestions -- find the most plausible historical message that starts with
 * what has been typed, then offer the remainder as ghost text.
 *
 * Source is kept pure ASCII on purpose (workspace convention).
 */

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
function normalizeRaw(key) {
  return key
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

export function normalizeForMatch(text) {
  const key = String(text ?? '');
  // Short strings (1-2 chars, including per-character cursor walks) must bypass
  // the cache so they never evict full history entries.
  if (key.length <= 2) return normalizeRaw(key);
  const hit = NORMALIZE_CACHE.get(key);
  if (hit !== undefined) return hit;
  const value = normalizeRaw(key);
  if (NORMALIZE_CACHE.size >= NORMALIZE_CACHE_LIMIT) {
    const oldest = NORMALIZE_CACHE.keys().next().value;
    if (oldest !== undefined) NORMALIZE_CACHE.delete(oldest);
  }
  NORMALIZE_CACHE.set(key, value);
  return value;
}

/** Diagnostic hook for tests verifying short-string bypass does not thrash the cache. */
export function normalizeCacheSize() {
  return NORMALIZE_CACHE.size;
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
export function nextWordLength(suffix) {
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
export function suggestionRemainder(suggestion, draft) {
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
    consumed += normalizeRaw(char).length;
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
export function historyCompletion(history, draft, options = {}) {
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
      consumed += normalizeRaw(char).length;
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
