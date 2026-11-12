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
 * Comparison key for a draft or candidate.
 *
 * Width, case and internal whitespace differences are typing accidents, so they
 * must not break a match. The returned string is only ever used for comparison;
 * the text shown to the user is always the candidate's original bytes.
 */
export function normalizeForMatch(text) {
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
