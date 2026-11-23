import assert from 'node:assert/strict';
import test from 'node:test';
import { clearGhost, findEditor, ghostState, paintGhost, GHOST_ATTR } from '../lib/ghost.js';

function fixture() {
  const listeners = new Map();
  const observers = [];
  function element() {
    return {
      children: [], parentElement: null, attributes: {}, dataset: {}, style: {}, textContent: '',
      setAttribute(key, value) { this.attributes[key] = value; },
      appendChild(child) {
        child.remove();
        this.children.push(child);
        child.parentElement = this;
        return child;
      },
      removeChild(child) {
        const index = this.children.indexOf(child);
        if (index < 0) throw new Error('not a child');
        this.children.splice(index, 1);
        child.parentElement = null;
      },
      remove() { this.parentElement?.removeChild(this); },
      querySelector(selector) { return select(this, selector)[0] ?? null; },
      getBoundingClientRect() { return this.rect ?? { left: 0, top: 0, width: 300 }; },
    };
  }
  function all(root) { return root.children.flatMap((child) => [child, ...all(child)]); }
  function select(root, selector) {
    const scoped = selector.match(/^\[data-conversation-session="(.*)"\] (.*)$/);
    if (scoped) {
      const key = scoped[1].replace(/\\([0-9a-f]+) /g, (_, code) => String.fromCharCode(parseInt(code, 16)));
      return all(root).filter((node) => node.attributes['data-conversation-session'] === key)
        .flatMap((node) => select(node, scoped[2]));
    }
    const attr = selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
    if (!attr) throw new Error(`unsupported selector ${selector}`);
    return all(root).filter((node) => Object.hasOwn(node.attributes, attr[1])
      && (attr[2] === undefined || node.attributes[attr[1]] === attr[2]));
  }
  const root = element();
  const head = root.appendChild(element());
  const body = root.appendChild(element());
  const doc = {
    head, body, createElement: element,
    querySelector: (selector) => select(root, selector)[0] ?? null,
    querySelectorAll: (selector) => select(root, selector),
    getElementById: (id) => all(root).find((node) => node.id === id) ?? null,
    defaultView: {
      getComputedStyle: () => ({ paddingLeft: '10px', paddingRight: '10px', paddingTop: '3px' }),
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(fn);
      },
      removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
      ResizeObserver: class {
        constructor(fn) { this.fn = fn; this.targets = []; this.disconnected = false; observers.push(this); }
        observe(target) { this.targets.push(target); }
        disconnect() { this.disconnected = true; }
      },
    },
  };
  function composer(key, marked = true) {
    const conversation = body.appendChild(element());
    if (marked) conversation.setAttribute('data-conversation-session', key);
    const host = conversation.appendChild(element());
    const editor = host.appendChild(element());
    editor.setAttribute('data-composer-input', 'true');
    const placeholder = host.appendChild(element());
    placeholder.setAttribute('data-composer-placeholder', '');
    placeholder.style.display = 'inline';
    return { conversation, host, editor, placeholder };
  }
  const layer = (host) => host.children.find((node) => Object.hasOwn(node.attributes, GHOST_ATTR));
  const fire = (type) => { for (const fn of [...(listeners.get(type) ?? [])]) fn(); };
  return { doc, composer, layer, observers, listeners, fire };
}

test('two sessions preserve text, placeholder and resources across selective clearing', (t) => {
  const f = fixture();
  t.after(() => clearGhost(f.doc));
  const a = f.composer('a');
  const b = f.composer('b');
  paintGhost(f.doc, 'a', 'alpha', { prefix: 'typed ' });
  paintGhost(f.doc, 'b', 'beta');
  const aLayer = f.layer(a.host);
  const bLayer = f.layer(b.host);
  assert.notEqual(aLayer, bLayer);
  assert.deepEqual(aLayer.children.map((node) => node.textContent), ['typed ', 'alpha']);
  assert.equal(bLayer.children[0].textContent, 'beta');
  assert.equal(a.placeholder.style.display, 'none');
  assert.equal(b.placeholder.style.display, 'none');
  assert.equal(f.doc.head.children.length, 1);
  paintGhost(f.doc, 'a', '');
  assert.equal(a.placeholder.style.display, 'inline');
  assert.equal(b.placeholder.style.display, 'none');
  assert.equal(bLayer.dataset.shown, '1');
  clearGhost(f.doc, 'a');
  assert.equal(f.layer(a.host), undefined);
  assert.equal(f.layer(b.host), bLayer);
  assert.equal(f.doc.head.children.length, 1);
  assert.equal(f.listeners.get('resize').size, 1);
  assert.equal(f.observers[0].disconnected, true);
  assert.equal(f.observers[1].disconnected, false);
  assert.deepEqual(ghostState(f.doc, 'b'), { shown: true, session: 'b' });
  clearGhost(f.doc);
  assert.equal(b.placeholder.style.display, 'inline');
  assert.equal(f.layer(b.host), undefined);
  assert.equal(f.doc.head.children.length, 0);
  assert.equal(f.listeners.get('resize').size, 0);
  assert.equal(f.listeners.get('scroll').size, 0);
  assert.equal(f.observers[1].disconnected, true);
});

test('documents own separate layers, styles, placeholders and windows', (t) => {
  const a = fixture();
  const b = fixture();
  t.after(() => { clearGhost(a.doc); clearGhost(b.doc); });
  const ac = a.composer('same');
  const bc = b.composer('same');
  paintGhost(a.doc, 'same', 'first');
  paintGhost(b.doc, 'same', 'second');
  clearGhost(a.doc);
  assert.equal(ac.placeholder.style.display, 'inline');
  assert.equal(bc.placeholder.style.display, 'none');
  assert.equal(b.layer(bc.host).children[0].textContent, 'second');
  assert.equal(b.doc.head.children.length, 1);
  assert.equal(b.listeners.get('scroll').size, 1);
  assert.equal(b.observers[0].disconnected, false);
});

test('missing scoped editor never paints another session and clears only stale ownership', (t) => {
  const f = fixture();
  t.after(() => clearGhost(f.doc));
  const a = f.composer('a');
  const b = f.composer('b');
  paintGhost(f.doc, 'a', 'first');
  paintGhost(f.doc, 'b', 'second');
  a.editor.remove();
  assert.equal(findEditor(f.doc, 'a'), null);
  paintGhost(f.doc, 'a', 'wrong');
  assert.equal(f.layer(a.host), undefined);
  assert.equal(a.placeholder.style.display, 'inline');
  assert.equal(f.layer(b.host).children[0].textContent, 'second');
  assert.equal(b.placeholder.style.display, 'none');
  const count = f.doc.head.children.length;
  paintGhost(f.doc, 'missing', 'wrong');
  assert.equal(ghostState(f.doc, 'missing'), null);
  assert.equal(f.doc.head.children.length, count);
});

test('legacy fallback requires one editor and no conversation markers', (t) => {
  const f = fixture();
  t.after(() => clearGhost(f.doc));
  const a = f.composer('', false);
  assert.equal(findEditor(f.doc, 'legacy'), a.editor);
  paintGhost(f.doc, 'old', 'old');
  paintGhost(f.doc, 'new', 'new');
  assert.equal(ghostState(f.doc, 'old'), null);
  assert.equal(a.host.children.filter((node) => Object.hasOwn(node.attributes, GHOST_ATTR)).length, 1);
  clearGhost(f.doc, 'new');
  assert.equal(a.placeholder.style.display, 'inline');
  const b = f.composer('', false);
  assert.equal(findEditor(f.doc, 'legacy'), null);
  assert.equal(findEditor(f.doc), null);
  b.conversation.remove();
  a.conversation.setAttribute('data-conversation-session', 'other');
  assert.equal(findEditor(f.doc, 'legacy'), null);
});

for (const trigger of ['paint', 'resize', 'observer']) {
  test(`editor remount rebinds observer and restores old placeholder on ${trigger}`, (t) => {
    const f = fixture();
    t.after(() => clearGhost(f.doc));
    const old = f.composer('a');
    paintGhost(f.doc, 'a', 'kept');
    const layer = f.layer(old.host);
    old.conversation.remove();
    const next = f.composer('a');
    next.editor.rect = { left: 33, top: 44, width: 200 };
    if (trigger === 'paint') paintGhost(f.doc, 'a', 'kept');
    if (trigger === 'resize') f.fire('resize');
    if (trigger === 'observer') f.observers[0].fn();
    assert.equal(f.layer(old.host), undefined);
    assert.equal(f.layer(next.host), layer);
    assert.equal(old.placeholder.style.display, 'inline');
    assert.equal(next.placeholder.style.display, 'none');
    assert.equal(layer.style.left, '43px');
    assert.equal(f.observers[0].disconnected, true);
    assert.deepEqual(f.observers[1].targets, [next.editor]);
    assert.equal(f.listeners.get('resize').size, 1);
    clearGhost(f.doc, 'a');
    assert.equal(next.placeholder.style.display, 'inline');
    assert.equal(f.observers[1].disconnected, true);
    f.observers[0].fn();
    assert.equal(f.doc.head.children.length, 0, 'queued stale callbacks do not recreate resources');
  });
}

test('legacy ownership transfer also releases an editor replaced before repaint', (t) => {
  const f = fixture();
  t.after(() => clearGhost(f.doc));
  const old = f.composer('', false);
  paintGhost(f.doc, 'old', 'old');
  old.conversation.remove();
  const next = f.composer('', false);
  paintGhost(f.doc, 'new', 'new');
  assert.equal(ghostState(f.doc, 'old'), null);
  assert.equal(old.placeholder.style.display, 'inline');
  assert.equal(f.observers[0].disconnected, true);
  f.observers[0].fn();
  assert.equal(f.layer(next.host).children[0].textContent, 'new');
  assert.equal(f.listeners.get('resize').size, 1);
});

test('a resize after editor removal releases all owned resources', () => {
  const f = fixture();
  const a = f.composer('a');
  paintGhost(f.doc, 'a', 'text');
  a.editor.remove();
  f.fire('resize');
  assert.equal(a.placeholder.style.display, 'inline');
  assert.equal(f.layer(a.host), undefined);
  assert.equal(f.doc.head.children.length, 0);
  assert.equal(f.listeners.get('scroll').size, 0);
  assert.equal(f.observers[0].disconnected, true);
});

test('an existing stylesheet remains outside this owner cleanup', (t) => {
  const f = fixture();
  t.after(() => clearGhost(f.doc));
  f.composer('a');
  const style = f.doc.createElement('style');
  style.id = 'next-say-ghost-style';
  f.doc.head.appendChild(style);
  paintGhost(f.doc, 'a', 'text');
  clearGhost(f.doc);
  assert.deepEqual(f.doc.head.children, [style]);
});

test('special session IDs resolve without selector interpolation', (t) => {
  const f = fixture();
  t.after(() => clearGhost(f.doc));
  const key = 'quote" slash\\ newline\n';
  const a = f.composer(key);
  paintGhost(f.doc, key, 'text');
  assert.equal(f.layer(a.host).children[0].textContent, 'text');
});

test('paintGhost short-circuits empty text when session has no state yet', (t) => {
  const f = fixture();
  t.after(() => clearGhost(f.doc));
  const a = f.composer('fresh');
  paintGhost(f.doc, 'fresh', '');
  assert.equal(f.layer(a.host), undefined, 'empty paint must not allocate a ghost layer');
  assert.equal(f.doc.head.children.length, 0, 'empty paint must not inject stylesheet');
  assert.equal(f.observers.length, 0, 'empty paint must not attach ResizeObserver');
  assert.equal(f.listeners.get('scroll')?.size ?? 0, 0, 'empty paint must not attach scroll listener');
});

test('ghost onMove coalesces via rAF, skips when hidden, and cancels pending rAF on clear', (t) => {
  const f = fixture();
  t.after(() => clearGhost(f.doc));
  let nextRafId = 0;
  const rafQueue = new Map();
  let cancelled = [];
  f.doc.defaultView.requestAnimationFrame = (fn) => {
    const id = ++nextRafId;
    rafQueue.set(id, fn);
    return id;
  };
  f.doc.defaultView.cancelAnimationFrame = (id) => {
    cancelled.push(id);
    rafQueue.delete(id);
  };
  let rectReads = 0;
  const a = f.composer('s');
  const origRect = a.editor.getBoundingClientRect.bind(a.editor);
  a.editor.getBoundingClientRect = () => { rectReads += 1; return origRect(); };

  paintGhost(f.doc, 's', 'hello');
  const afterInitialPaint = rectReads;
  // Multiple scroll events within one frame coalesce into a single rAF.
  f.fire('scroll');
  f.fire('scroll');
  f.fire('resize');
  assert.equal(rafQueue.size, 1, 'multiple moves must schedule only one rAF');
  assert.equal(rectReads, afterInitialPaint, 'layout must wait for rAF');
  const [[firstId, firstFn]] = [...rafQueue.entries()];
  rafQueue.delete(firstId);
  firstFn();
  assert.equal(rectReads, afterInitialPaint + 1, 'rAF callback updates layout once');

  // Hiding the ghost stops scroll/resize from scheduling rAF or reading layout.
  paintGhost(f.doc, 's', '');
  const afterHide = rectReads;
  f.fire('scroll');
  f.fire('resize');
  assert.equal(rafQueue.size, 0, 'hidden ghost must not schedule rAF on scroll/resize');
  assert.equal(rectReads, afterHide, 'hidden ghost must not read layout');

  // Pending rAF is cancelled when clearGhost runs.
  paintGhost(f.doc, 's', 'again');
  f.fire('scroll');
  assert.equal(rafQueue.size, 1);
  const [pendingId] = rafQueue.keys();
  clearGhost(f.doc, 's');
  assert.deepEqual(cancelled, [pendingId]);
  assert.equal(rafQueue.size, 0);
});
