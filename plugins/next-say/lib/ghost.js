/** Text-only ghost layers, owned by document and session, inside each composer. */
export const GHOST_ATTR = 'data-next-say-ghost';
const STYLE_ID = 'next-say-ghost-style';
const ghostDocuments = new WeakMap();
let lastGhost = null;

/** Host objects and test doubles must never control an unbounded loop. */
export function clearChildren(node) {
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
export function findEditor(doc, sessionId) {
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
export function clearGhost(doc, sessionId) {
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
export function paintGhost(doc, sessionId, text, options = {}) {
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
export function ghostState(doc, sessionId) {
  let state = lastGhost;
  if (doc != null) {
    const sessions = ghostDocuments.get(doc)?.sessions;
    state = sessions?.get(sessionKey(sessionId));
    if (arguments.length < 2 && sessions !== undefined) state = [...sessions.values()].at(-1);
  }
  return state == null ? null : { shown: state.layer.dataset.shown === '1', session: state.key };
}
