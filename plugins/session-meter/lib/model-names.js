/**
 * Shared model-name normalization and candidate expansion for session-meter.
 *
 * Kept free of Node built-ins so both the Host (`lib/prices.js`) and the
 * browser bundle (`client/bundle.json` -> `lib/client.js`) share one exact
 * implementation of `nameCandidates` and `normalizeModelKey`.
 *
 * Pure ASCII only (workspace convention).
 */

/** Trailing release-suffix noise that relays append to an official model id. */
export const RELEASE_SUFFIX = /-(preview|latest|free|beta|alpha|experimental|contributor)$/;

/**
 * Context-window tag a route appends after the real id (`grok-4.7@500k`,
 * `@1m`, `@128k`). Dated snapshots (`claude-opus-4-5@20251101`) have no k/m/b
 * unit, so they stay intact.
 */
export const CONTEXT_SUFFIX = /@\d+(?:\.\d+)?[kmb]$/;

/**
 * Canonical spelling of a model id for near-match comparison: version
 * separators between digits are equivalent (`muse-wonder-1-0` is
 * `muse-wonder-1.0`), and a context-window tag is not part of the id.
 *
 * @param {string} value
 * @returns {string}
 */
export function normalizeModelKey(value) {
  return String(value).toLowerCase().replace(CONTEXT_SUFFIX, '').replace(/(\d)[-_](?=\d)/g, '$1.');
}

/**
 * Every spelling of a routed model id worth trying against the catalog.
 *
 * @param {string|undefined} model - routed model id, `provider/model` or bare.
 * @returns {string[]} distinct lowercase candidates, most specific first.
 */
export function nameCandidates(model) {
  if (typeof model !== 'string' || model.length === 0) return [];
  const lower = model.toLowerCase();
  const forms = [lower];
  const bare = lower.replace(CONTEXT_SUFFIX, '');
  if (bare !== lower) forms.push(bare);
  const collapseMinor = (value) => value.replace(/\.(\d+)(?=[-/])/g, '');
  const stripSuffix = (value) => value.replace(RELEASE_SUFFIX, '');
  const out = [];
  const push = (value) => {
    if (value.length > 0 && !out.includes(value)) out.push(value);
  };
  for (const form of forms) {
    const slash = form.lastIndexOf('/');
    const tail = slash >= 0 ? form.slice(slash + 1) : form;
    push(form);
    push(tail);
    for (const value of [tail, collapseMinor(tail)]) {
      push(stripSuffix(value));
      push(collapseMinor(stripSuffix(value)));
      push(stripSuffix(collapseMinor(value)));
    }
  }
  return out;
}
