import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createToastSender, fireToast, TOAST_PROCESS_TIMEOUT_MS } from '../lib/index.js';

function harness(overrides = {}) {
  const launches = [];
  const warnings = [];
  const child = new EventEmitter();
  const environment = { WINDIR: 'C:/Windows', PATH: 'fixture-path', USER: 'fixture-user',
    EXAMPLE_API_KEY: 'private-key', example_secret: 'private-secret', EXAMPLE_TOKEN: 'private-token',
    PASSWORD: 'private-password', TR_TITLE: 'inherited-title' };
  const sender = createToastSender({ platform: 'win32', environment: () => environment,
    fileExists: () => true,
    spawnProcess: (...args) => { launches.push(args); return child; }, ...overrides });
  const ctx = { logger: { warn: (message) => warnings.push(message) } };
  return { sender, ctx, launches, warnings, child, environment };
}
const cfg = { toast: { persistent: true, iconPath: '' } };
const payload = { title: 'Title "<&>', body: 'Body $(not-a-command)', location: 'Workspace' };

test('toast sender uses UTF-16LE EncodedCommand and passes only data through env', () => {
  const h = harness();
  assert.equal(h.sender(h.ctx, cfg, payload), true);
  assert.equal(h.launches.length, 1);
  const [executable, args, options] = h.launches[0];
  assert.equal(executable, join('C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
  assert.deepEqual(args.slice(0, 5), ['-NoProfile', '-STA', '-WindowStyle', 'Hidden', '-EncodedCommand']);
  const script = Buffer.from(args[5], 'base64').toString('utf16le');
  assert.match(script, /ToastNotificationManager/);
  assert.match(script, /\$env:TR_TITLE/);
  assert.match(script, /XmlEscape/);
  assert.equal(script.includes(payload.body), false);
  assert.equal(script.includes(payload.title), false);
  assert.equal(options.env.TR_TITLE, payload.title);
  assert.equal(options.env.TR_BODY, payload.body);
  assert.equal(options.env.TR_LOCATION, payload.location);
  assert.equal(options.env.TR_PERSIST, '1');
  assert.equal(options.env.PATH, 'fixture-path');
  for (const key of ['EXAMPLE_API_KEY', 'example_secret', 'EXAMPLE_TOKEN', 'PASSWORD']) {
    assert.equal(Object.hasOwn(options.env, key), false, key);
  }
  assert.equal(h.environment.TR_TITLE, 'inherited-title', 'parent env is unchanged');
  assert.equal(options.windowsHide, true);
  assert.equal(options.stdio, 'ignore');
  assert.equal(options.shell, undefined);
  assert.equal(options.timeout, TOAST_PROCESS_TIMEOUT_MS);
  assert.ok(options.timeout > 0 && options.timeout <= 30000);
  assert.equal(options.killSignal, 'SIGKILL');
});

test('default icon references the package PNG path, independent of platform separators', () => {
  const probes = [];
  const h = harness({ fileExists: (file) => { probes.push(file); return true; } });
  h.sender(h.ctx, cfg, payload);
  const expected = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'icon.png');
  assert.deepEqual(probes, [expected]);
  assert.equal(h.launches[0][2].env.TR_ICON, expected);
});

test('custom icon overrides default; a missing icon is omitted without losing the request', () => {
  const h = harness({ fileExists: () => false });
  assert.equal(h.sender(h.ctx, { toast: { persistent: false, iconPath: ' /fixture/custom.png ' } }, payload), true);
  assert.equal(h.launches[0][2].env.TR_ICON, '');
  assert.equal(h.launches[0][2].env.TR_PERSIST, '');
});

test('non-Windows sender does not inspect files, spawn or claim submission', () => {
  const h = harness({ platform: 'linux', fileExists: () => { throw new Error('unexpected filesystem access'); },
    spawnProcess: () => { throw new Error('unexpected process'); } });
  assert.equal(h.sender(h.ctx, cfg, payload), false);
  assert.deepEqual(h.warnings, []);
  assert.equal(typeof fireToast, 'function', 'the existing entrypoint stays exported');
});

test('synchronous process launch failure is logged and submission is false', () => {
  const h = harness({ spawnProcess: () => { throw new Error('fixture launch failure'); } });
  assert.equal(h.sender(h.ctx, cfg, payload), false);
  assert.match(h.warnings[0], /failed to launch toast:.*fixture launch failure/);
});

test('asynchronous process errors and nonzero or timed-out exits are logged', () => {
  const h = harness();
  h.sender(h.ctx, cfg, payload);
  h.child.emit('error', new Error('fixture async failure'));
  h.child.emit('exit', null, 'SIGKILL');
  assert.match(h.warnings[0], /toast process error:.*fixture async failure/);
  assert.match(h.warnings[1], /toast process exited:.*SIGKILL/);
  assert.equal(h.child.listenerCount('error'), 0);
  assert.equal(h.child.listenerCount('exit'), 0);
  const nonzero = harness();
  nonzero.sender(nonzero.ctx, cfg, payload);
  nonzero.child.emit('exit', 1, null);
  assert.match(nonzero.warnings[0], /toast process exited: 1/);
});

test('successful process exit is not described as a failure', () => {
  const h = harness();
  h.sender(h.ctx, cfg, payload);
  h.child.emit('exit', 0, null);
  assert.deepEqual(h.warnings, []);
});
