/**
 * Contracts for the in-composer ghost layer.
 *
 * These run against `lib/ghost.js`, which tools/client-build inlines byte for
 * byte into `lib/client.js`, so a green run covers the code that executes in the
 * browser. No real DOM is needed: the module uses only the handful of DOM methods
 * stubbed below, and asserting on those calls IS the contract.
 *
 * What went wrong before, and what these tests now prevent:
 *   1. The suggestion lived in a row ABOVE the composer whose width did not match
 *      the card, so the trailing controls were pushed outside it. The structural
 *      fix is that the ghost now lives INSIDE the composer, in the editor's own
 *      parent, which is what the first test asserts.
 *   2. A history completion painted the WHOLE candidate, so it looked like the
 *      draft repeating itself. The paint call must receive draft + remainder.
 *   3. `historyRef` was a ref, invisible to useMemo, so the completion was
 *      computed once against an empty pool and never appeared afterwards.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { GHOST_ATTR, clearGhost, findEditor, ghostState, paintGhost } from '../lib/ghost.js';

const TEMPLATE = new URL('../client/client.template.js', import.meta.url);

/* --------------------------------------------------------------- fake DOM */

/** The smallest DOM that `paintGhost` actually touches. */
function createDom(options = {}) {
  const listeners = [];

  function element(tag) {
    const node = {
      tagName: String(tag).toUpperCase(),
      parentElement: null,
      dataset: {},
      style: {},
      children: [],
      attributes: {},
      textContent: '',
      innerHTML: '',
      className: '',
      // `element.id = x` must be findable by getElementById, exactly like the
      // real DOM. Keeping them separate hid a duplicate stylesheet injection.
      set id(value) {
        this.attributes.id = String(value);
      },
      get id() {
        return this.attributes.id ?? '';
      },
      setAttribute(name, value) {
        this.attributes[name] = value;
      },
      appendChild(child) {
        child.parentElement = this;
        this.children.push(child);
        return child;
      },
      removeChild(child) {
        const at = this.children.indexOf(child);
        if (at >= 0) {
          this.children.splice(at, 1);
          child.parentElement = null;
        }
        return child;
      },
      remove() {
        if (this.parentElement !== null) {
          const at = this.parentElement.children.indexOf(this);
          if (at >= 0) this.parentElement.children.splice(at, 1);
          this.parentElement = null;
        }
      },
      addEventListener(type, handler) {
        listeners.push({ node: this, type, handler });
      },
      querySelector(selector) {
        if (selector === '.ns-ghost-text') return this.children.find((c) => c.className === 'ns-ghost-text') ?? null;
        if (selector === '.ns-ghost-actions') return this.children.find((c) => c.className === 'ns-ghost-actions') ?? null;
        return null;
      },
      getBoundingClientRect() {
        return this.rect ?? { left: 0, top: 0, width: 0, height: 0 };
      },
      contains(node) {
        if (node === this) return true;
        return this.children.some((child) => child.contains === undefined ? child === node : child.contains(node));
      },
    };
    return node;
  }

  const head = element('head');
  const body = element('body');

  // editor -> .grow host, as the real composer nests it.
  const host = element('div');
  const editor = element('div');
  const placeholder = element('div');
  placeholder.attributes['data-composer-placeholder'] = '';
  placeholder.style.display = 'block';
  editor.rect = { left: 40, top: 100, width: 320, height: 52 };
  host.rect = { left: 20, top: 90, width: 360, height: 80 };
  host.appendChild(editor);
  host.appendChild(placeholder);
  // `host.querySelector('[data-composer-placeholder]')` is how the ghost finds it.
  host.querySelector = (selector) => (selector === '[data-composer-placeholder]' ? placeholder : null);
  body.appendChild(host);

  const doc = {
    head,
    body,
    createElement: (tag) => element(tag),
    getElementById(id) {
      // Match the real DOM: getElementById searches the WHOLE tree, not just the
      // document's direct children. A shallower stub made the stylesheet guard
      // look broken and injected a second sheet on every paint.
      const find = (node) => {
        if (node.attributes.id === id) return node;
        for (const child of node.children) {
          const hit = find(child);
          if (hit !== null) return hit;
        }
        return null;
      };
      return find(head) ?? find(body);
    },
    querySelector(selector) {
      if (!selector.includes('[data-composer-input="true"]')) return null;
      return options.noEditor === true ? null : editor;
    },
    defaultView: {
      getComputedStyle: () => ({
        paddingLeft: '14px',
        paddingRight: '8px',
        paddingTop: '4px',
        fontFamily: 'Test Sans',
        fontSize: '14px',
        lineHeight: '24px',
        fontWeight: '400',
        letterSpacing: 'normal',
      }),
      addEventListener(type, handler) {
        listeners.push({ node: null, type, handler, removed: false });
      },
      removeEventListener(type, handler) {
        const found = listeners.find((l) => l.node === null && l.type === type && l.handler === handler);
        if (found) found.removed = true;
      },
    },
  };

  return { doc, host, editor, placeholder, listeners };
}

/** The ghost layer inside `host`, whichever paint created it. */
function layerOf(host) {
  return host.children.find((child) => child.attributes[GHOST_ATTR] !== undefined);
}

/* ------------------------------------------------------------------ tests */

test('the ghost is appended INSIDE the composer, beside the editor', () => {
  const { doc, host } = createDom();
  paintGhost(doc, 's1', 'next sentence');
  assert.ok(layerOf(host), 'the ghost layer must live in the editor host');
  // The editor and the placeholder remain siblings: the ghost overlays them.
  assert.equal(host.children.length, 3, 'host = editor + placeholder + ghost layer');
});

test('the ghost is invisible to assistive tech and to the mouse', () => {
  const { doc, host } = createDom();
  paintGhost(doc, 's1', 'text');
  assert.equal(layerOf(host).attributes['aria-hidden'], 'true');
  assert.match(doc.head.children[0].textContent, /pointer-events:\s*none/);
  assert.match(doc.head.children[0].textContent, /user-select:\s*none/);
});

test('the layer is measured against the editor content box', () => {
  const { doc, host } = createDom();
  paintGhost(doc, 's1', 'text');
  const layer = layerOf(host);
  // editor.left - host.left + paddingLeft = 40 - 20 + 14
  assert.equal(layer.style.left, '34px');
  // editor.top - host.top + paddingTop = 100 - 90 + 4
  assert.equal(layer.style.top, '14px');
  // width = editor width - horizontal padding, so text wraps like the editor's
  assert.equal(layer.style.width, '298px');
  // Font metrics are copied, otherwise the ghost does not line up with the draft.
  assert.equal(layer.style.fontFamily, 'Test Sans');
  assert.equal(layer.style.fontSize, '14px');
  assert.equal(layer.style.lineHeight, '24px');
});

test('an empty text hides the layer instead of leaving a stray box', () => {
  const { doc, host } = createDom();
  paintGhost(doc, 's1', 'text');
  const layer = layerOf(host);
  assert.equal(layer.dataset.shown, '1');
  paintGhost(doc, 's1', '');
  assert.equal(layer.dataset.shown, '0');
  assert.equal(layer.textContent, '', 'the text must be cleared too');
});

test('the ghost is text only: no controls live in the composer', () => {
  // Buttons inside the input box pushed the text around; Tab and Escape are the
  // controls. The layer may hold spans (the invisible prefix plus the ghost), but
  // never an interactive element.
  const { doc, host } = createDom();
  paintGhost(doc, 's1', 'run the tests');
  const layer = layerOf(host);
  for (const child of layer.children) {
    assert.notEqual(child.tagName, 'BUTTON');
    assert.equal(child.attributes && child.attributes.tabindex, undefined);
  }
  assert.ok(!/button/i.test(doc.head.children[0].textContent), 'no button styling either');
});

test('the host placeholder is hidden while a ghost shows, and restored after', () => {
  // Leaving the host's own "Message or run a task..." placeholder visible put two
  // lines of text in the same box.
  const { doc, host, placeholder } = createDom();
  placeholder.style.display = 'block';

  paintGhost(doc, 's1', 'next sentence');
  assert.equal(placeholder.style.display, 'none', 'the placeholder must be hidden');

  paintGhost(doc, 's1', '');
  assert.equal(placeholder.style.display, 'block', 'the previous value must come back');

  paintGhost(doc, 's1', 'again');
  clearGhost(doc);
  assert.equal(placeholder.style.display, 'block', 'clear must restore it too');
});

test('a continuation reserves the typed prefix and then draws only the remainder', () => {
  // The alignment bug: positioning the ghost at the caret rect landed it about a
  // glyph early and a little high, on top of the last typed character. The fix is
  // to place the layer at the content origin and let an INVISIBLE copy of the
  // draft take up its real width, so the ghost flows after it with the editor's
  // own metrics.
  const { doc, host } = createDom();
  paintGhost(doc, 's1', ' bar', { prefix: 'run the te' });
  const layer = layerOf(host);

  assert.equal(layer.children.length, 2, 'spacer + ghost');
  const [spacer, ghost] = layer.children;
  assert.equal(spacer.textContent, 'run the te');
  assert.equal(spacer.style.visibility, 'hidden', 'the prefix must not paint');
  assert.equal(ghost.textContent, ' bar');
  assert.notEqual(ghost.style.visibility, 'hidden', 'the remainder must paint');

  // The layer sits at the editor content origin, not at a measured caret.
  // editor.left 40 - host.left 20 + paddingLeft 14 = 34px
  assert.equal(layer.style.left, '34px');
  // editor.top 100 - host.top 90 + paddingTop 4 = 14px
  assert.equal(layer.style.top, '14px');
});

test('a whole prediction has no spacer', () => {
  const { doc, host } = createDom();
  paintGhost(doc, 's1', 'a whole next message');
  const layer = layerOf(host);
  assert.equal(layer.children.length, 1, 'only the ghost span');
  assert.equal(layer.children[0].textContent, 'a whole next message');
});

test('clearing removes the layer and its stylesheet', () => {
  const { doc, host } = createDom();
  paintGhost(doc, 's1', 'text');
  assert.notEqual(ghostState(), null);
  clearGhost(doc);
  assert.equal(host.children.length, 2, 'editor + placeholder remain');
  assert.equal(doc.head.children.length, 0, 'the stylesheet is removed too');
  assert.equal(ghostState(), null);
});

test('a missing editor is not an error', () => {
  const { doc } = createDom({ noEditor: true });
  assert.doesNotThrow(() => paintGhost(doc, 's1', 'text'));
  assert.doesNotThrow(() => clearGhost(doc));
  assert.equal(findEditor(doc, 's1'), null);
});

test('an unloaded document is tolerated', () => {
  assert.doesNotThrow(() => clearGhost(undefined));
  assert.doesNotThrow(() => paintGhost(undefined, 's1', 'text'));
});

test('the stylesheet is injected once, not per paint', () => {
  const { doc } = createDom();
  paintGhost(doc, 's1', 'a');
  paintGhost(doc, 's1', 'b');
  assert.equal(doc.head.children.length, 1);
});

/* ------------------------------------------------ behaviours fixed after bug */

test('a completion passes the draft as an invisible prefix, not as visible text', () => {
  const source = readFileSync(TEMPLATE, 'utf8');
  assert.match(source, /const ghostText = modelText !== '' \? modelText : localSuffix;/);
  assert.match(source, /const ghostPrefix = modelText !== '' \? '' : draft;/);
  assert.match(source, /paintGhost\(document, sessionId, ghostText, \{ prefix: ghostPrefix \}\)/);
  // Re-drawing the draft as visible text is what made it look doubled.
  assert.ok(!/draft \+ localSuffix/.test(source), 'the draft must not be re-drawn');
});

test('the completion memo is invalidated when the history pool arrives', () => {
  const source = readFileSync(TEMPLATE, 'utf8');
  assert.match(source, /const \[historyEpoch, setHistoryEpoch\]/, 'a version state is required');
  assert.match(
    source,
    /\}, \[enabled, settings, blankDraft, draft, historyEpoch\]\);/,
    'historyEpoch must be a memo dependency',
  );
  const writes = source.match(/historyRef\.current = items;/g) ?? [];
  const bumps = source.match(/setHistoryEpoch\(\(value\) => value \+ 1\)/g) ?? [];
  assert.ok(writes.length > 0, 'the pool must actually be written');
  assert.equal(bumps.length, writes.length, `every history write needs a bump: ${writes.length}/${bumps.length}`);
});

test('the ghost component never returns before all of its hooks', () => {
  const source = readFileSync(TEMPLATE, 'utf8');
  const start = source.indexOf('function GhostPainter(props) {');
  assert.notEqual(start, -1, 'GhostPainter must exist');
  // Bound the slice to this component: the settings page that follows also has
  // body-level returns, and counting those would defeat the assertion.
  const end = source.indexOf('/* ----------------------------------------------------------- settings */', start);
  assert.notEqual(end, -1, 'the settings section marker must follow the component');
  const body = source.slice(start, end);

  // The exact bug that made the composer show nothing: `if (!enabled) return
  // null;` sat BETWEEN hook calls. `enabled` flips false -> true when the
  // settings arrive, so the next render declared more hooks than the previous
  // one and React threw. The slot renderer swallows that, leaving an empty
  // composer and no visible error anywhere.
  assert.ok(
    !/^\s*if \(!enabled\) return null;/m.test(body),
    'no conditional return may sit between hooks; handle it inside the effect',
  );

  // A body-level early return is indented six spaces inside the factory. There
  // may be exactly one, and it must be the final statement.
  const bodyLevel = body
    .split('\n')
    .filter((line) => /^ {6}return\b/.test(line))
    .map((line) => line.trim());
  assert.deepEqual(bodyLevel, ['return null;'], `body-level returns: ${JSON.stringify(bodyLevel)}`);
});

test('every ref the ghost component reads is declared', () => {
  // A rewrite once dropped `const draftRef = React.useRef(...)` while leaving two
  // `draftRef.current` reads. `predict()` threw a ReferenceError before reaching
  // the network and its own try/catch swallowed it, so /predict never fired and
  // nothing was logged anywhere. This pins the whole class: any `<name>.current`
  // read must have a matching declaration in the same component.
  const source = readFileSync(TEMPLATE, 'utf8');
  const start = source.indexOf('function GhostPainter(props) {');
  const end = source.indexOf('/* ----------------------------------------------------------- settings */', start);
  const body = source.slice(start, end);

  const declared = new Set(
    [...body.matchAll(/const\s+(\w+)\s*=\s*React\.useRef\(/g)].map((m) => m[1]),
  );
  const used = new Set([...body.matchAll(/(\w+)\.current\b/g)].map((m) => m[1]));

  const missing = [...used].filter((name) => !declared.has(name));
  assert.deepEqual(missing, [], `refs read but never declared: ${missing.join(', ')}`);
});

test('typing hides a prediction; only a running turn discards it', () => {
  // Two different lifetimes, and conflating them caused both reported bugs:
  //   - discarding on typing    -> after clearing the box the prediction was gone
  //                                and never came back;
  //   - discarding only on accept-> after sending, the stale sentence sat in the
  //                                empty composer while the agent worked.
  const source = readFileSync(TEMPLATE, 'utf8');

  // Rendering it is gated on an empty, idle composer.
  assert.match(
    source,
    /const modelText = suggestion !== ''[^;]*&& blankDraft && !running/,
    'the prediction is only valid for an empty, idle composer',
  );

  // Discarding it is gated on the turn starting, NOT on the draft.
  const discard = source.slice(
    source.indexOf('React.useEffect(() => {', source.indexOf('a turn   -> DISCARD')),
    source.indexOf('}, [suggestion, running]'),
  );
  assert.match(discard, /if \(suggestion === ''\) return;/);
  assert.match(discard, /if \(!running\) return;/);
  assert.ok(
    !/blankDraft/.test(discard),
    'the discard effect must not depend on the draft, or typing deletes the prediction',
  );
});

test('the entry mounts into the composer overlay, not the dock above it', () => {
  const source = readFileSync(TEMPLATE, 'utf8');
  assert.match(source, /slots\.inject\('conversation\.input\.overlay'/, 'must mount inside the composer card');
  assert.ok(
    !source.includes("slots.inject('conversation.input.dock'"),
    'the row above the composer is no longer used',
  );
});

test('accept still goes through the composer CAS, not a draft write', () => {
  const source = readFileSync(TEMPLATE, 'utf8');
  // captureInsertion + insertText is what prevents overwriting typed text.
  assert.match(source, /inputActions\.captureInsertion\(\)/);
  assert.match(source, /inputActions\.insertText\(text, span\)/);
});
