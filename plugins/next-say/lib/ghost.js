/**
 * In-composer ghost rendering for dsh-plugin-next-say.
 *
 * The ghost is TEXT ONLY, drawn inside the composer card over the editor, and it
 * never takes the caret or the mouse. Two rules make it look like an editor
 * feature rather than a widget:
 *
 *   1. The host's own placeholder is hidden while a ghost is shown. Leaving it
 *      visible produced two overlapping lines ("what is this").
 *   2. A continuation is drawn AT THE CARET and contains ONLY the remainder, so
 *      it never double-draws the text the user already typed. A prediction for an
 *      empty composer is drawn at the editor's content origin.
 *
 * No buttons live in here: acceptance is Tab, dismissal is Escape. Controls
 * inside the input box pushed the text around and looked wrong.
 *
 * Source is kept pure ASCII (workspace convention).
 */

/**
 * Remove every child of a node.
 *
 * Walks `children` when it is a live collection (real DOM and the test double
 * both provide one) and falls back to `firstChild`. A bare
 * `while (node.firstChild !== null)` loop spins forever on a host object without
 * that property, which is how a test run hung.
 */
export function clearChildren(node) {
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
export const GHOST_ATTR = 'data-next-say-ghost';

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
export function findEditor(doc, sessionId) {
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
export function paintGhost(doc, sessionId, text, options = {}) {
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
export function clearGhost(doc) {
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
export function ghostState() {
  return layer === null ? null : { shown: layer.dataset.shown === '1', session: layer.dataset.session };
}
