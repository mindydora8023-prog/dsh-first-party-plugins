// Real installed Cordis/Connection integration; no live Host or credentials.
// Run: node --test task-radar/test/connection-integration.test.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

const worker = process.argv.includes('--integration-worker');
if (!worker) {
  test('installed Connection and Cordis integration (25s external watchdog)', {
    skip: process.env.DSH_INSTALL_DIR ? false : 'set DSH_INSTALL_DIR to run installed-host integration',
  }, async () => {
    await new Promise((resolve, reject) => {
      // Inherit stdio: works under Windows confinement without named pipes.
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--integration-worker'], {
        stdio: 'inherit', windowsHide: true,
      });
      let expired = false;
      const timer = setTimeout(() => { expired = true; child.kill('SIGKILL'); }, 25000);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        if (expired) reject(new Error('integration exceeded external 25s hard timeout'));
        else if (code !== 0) reject(new Error(`integration worker failed: code=${code}, signal=${signal}`));
        else resolve();
      });
    });
  });
} else {
  await verify();
}

async function until(predicate, label) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error('timed out: ' + label);
}

async function verify() {
  const anchor = process.env.DSH_INSTALL_DIR;
  assert.ok(anchor, 'DSH_INSTALL_DIR must identify the current installation');
  const manifest = JSON.parse(readFileSync(join(anchor, 'package.json'), 'utf8'));
  assert.equal(manifest.name, '@deepseek-ai/dsh');
  const requireInstalled = createRequire(join(anchor, 'package.json'));
  const load = async (name) => {
    try { return await import(pathToFileURL(requireInstalled.resolve(name)).href); }
    catch (error) {
      // Fail explicitly; never replace real Connection with an auth stub.
      throw new Error('installed import failed for ' + name + ': ' + error.code);
    }
  };
  const cordis = await load('@deepseek-ai/cordis');
  const transport = await load('@deepseek-ai/dsh-client-connection');
  const pkg = (name) => JSON.parse(readFileSync(requireInstalled.resolve(name + '/package.json'), 'utf8'));
  console.log('Installed versions: DSH=' + manifest.version + ', Connection=' + pkg('@deepseek-ai/dsh-client-connection').version + ', Cordis=' + pkg('@deepseek-ai/cordis').version);
  await until(() => existsSync(new URL('../lib/fetch-handler.js', import.meta.url)), 'fetch-handler.js readiness');
  const radar = await import('../lib/index.js');
  assert.deepEqual(radar.inject, [], 'native notifications must not require Connection');

  const directory = mkdtempSync(join(tmpdir(), 'task-radar-connection-'));
  const oldConfig = process.env.TASK_RADAR_CONFIG_FILE;
  const file = join(directory, 'config.json');
  process.env.TASK_RADAR_CONFIG_FILE = file;
  const contexts = [];
  const fibers = [];
  let server;
  let record;
  let credentialCalls = 0;
  const rawRoutes = new Map();
  const sends = [];
  const mount = (ctx, name, implementation) => Object.assign(new cordis.Service(ctx, name), implementation);
  const installRadar = (ctx) => {
    // Keep function-valued dependency injection outside schema/config cloning.
    const fiber = ctx.plugin({ name: radar.name, inject: radar.inject, apply(c) {
      return radar.apply(c, { toastSender: (_ctx, cfg, payload) => { sends.push({ cfg, payload }); return true; } });
    } });
    fibers.push(fiber);
    return fiber;
  };
  try {
    const native = new cordis.Context();
    contexts.push(native);
    const nativeFiber = installRadar(native);
    await delay(50);
    assert.equal(native.get('connection'), undefined);
    const session = { id: 'fixture-session', header: { delegationDepth: 0, cwd: directory } };
    const agent = { id: session.id, session };
    native.emit('agent/status', { agent, status: 'running' });
    native.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } });
    native.emit('session/event', session, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
    native.emit('agent/status', { agent, status: 'idle' });
    assert.equal(sends.length, 1, 'real Cordis lifecycle must dispatch native sender without Connection');
    await nativeFiber.dispose();
    console.log('PASS native sender without Connection (injected sender; no OS Toast)');

    const ctx = new cordis.Context();
    contexts.push(ctx);
    mount(ctx, 'credentials', {
      async modifyRecord(_key, update) {
        credentialCalls++;
        const next = await update(record);
        if (next !== undefined) record = next;
        return record;
      },
    });
    mount(ctx, 'webServer', {
      host: '127.0.0.1', protocol: 'http:',
      register(route) {
        assert.ok(!rawRoutes.has(route.path));
        rawRoutes.set(route.path, route);
        return () => rawRoutes.delete(route.path);
      },
    });
    const connectionFiber = ctx.plugin(transport, {});
    fibers.push(connectionFiber);
    await until(() => ctx.get('connection') && rawRoutes.has('/api'), 'Connection activation');
    const connection = ctx.get('connection');
    assert.ok(connection instanceof transport.HostConnectionService);
    assert.equal(credentialCalls, 1, 'only fresh in-memory credentials were consulted');
    const radarFiber = installRadar(ctx);
    await until(() => connection.fetchRoutes.size === 3, 'three exact Fetch routes');
    const entries = [...connection.fetchRoutes].map(([path, route]) => [path, [...route.methods], route.requestBody]);
    assert.deepEqual(entries, [
      ['/api/task-radar/radar', ['GET', 'HEAD'], 'buffered'],
      ['/api/task-radar/config', ['POST'], 'streaming'],
      ['/api/task-radar/test', ['POST'], 'streaming'],
    ]);
    assert.deepEqual([...rawRoutes.keys()].sort(), ['/api', '/connect'], 'only Connection may register raw HTTP carrier routes');
    console.log('PASS three exact Fetch routes; buffered reads and streaming writes; no raw task-radar route');

    server = createServer((req, res) => {
      if (new URL(req.url, 'http://fixture').pathname === '/') {
        if (connection.authorizeIndex(req, res)) { res.writeHead(200); res.end('fixture index'); }
        return;
      }
      const route = rawRoutes.get('/api');
      Promise.resolve(route.handler(req, res)).catch(() => { res.writeHead(500); res.end('fixture carrier failure'); });
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const base = 'http://127.0.0.1:' + server.address().port;
    for (const path of ['/radar', '/config', '/test']) {
      const method = path === '/radar' ? 'GET' : 'POST';
      const response = await fetch(base + '/api/task-radar' + path, { method, signal: AbortSignal.timeout(2000) });
      assert.equal(response.status, 401);
      await response.arrayBuffer();
      const evil = await fetch(base + '/api/task-radar' + path, { method, headers: { origin: 'https://evil.invalid' }, signal: AbortSignal.timeout(2000) });
      assert.equal(evil.status, 403);
      await evil.arrayBuffer();
    }
    assert.equal(existsSync(file), false, 'rejected HTTP requests must not persist config');
    console.log('PASS real HTTP carrier: all three paths reject anonymous=401 and malicious Origin=403');

    // Mint only a fresh in-memory fixture browser session. Never read real
    // credentials or print the token/cookie. Exercise the physical bridge too.
    const login = await fetch(connection.authenticatedUrl(base + '/'), { redirect: 'manual', signal: AbortSignal.timeout(2000) });
    assert.equal(login.status, 303);
    const cookie = login.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie);
    await login.arrayBuffer();
    const httpGet = await fetch(base + '/api/task-radar/radar', { headers: { cookie }, signal: AbortSignal.timeout(2000) });
    assert.equal(httpGet.status, 200, 'authenticated GET must cross the real HTTP-to-Fetch bridge');
    const httpConfig = (await httpGet.json()).config;
    const httpHead = await fetch(base + '/api/task-radar/radar', { method: 'HEAD', headers: { cookie }, signal: AbortSignal.timeout(2000) });
    assert.equal(httpHead.status, 200);
    assert.equal((await httpHead.arrayBuffer()).byteLength, 0);
    const httpPost = await fetch(base + '/api/task-radar/config', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ config: { ...httpConfig, titlePrefix: 'HTTP fixture saved' } }), signal: AbortSignal.timeout(2000),
    });
    assert.equal(httpPost.status, 200);
    assert.equal((await httpPost.json()).config.titlePrefix, 'HTTP fixture saved');
    console.log('PASS authenticated real HTTP GET/HEAD + streamed POST through the physical Fetch bridge');

    const shared = connection.createSharedFetchHandler('/api');
    const owner = connection.createPeer({ principal: { kind: 'owner' } });
    const other = connection.createPeer({ principal: { kind: 'fixture-non-owner' } });
    assert.ok(owner instanceof transport.Peer);
    for (const [path, route] of connection.fetchRoutes) {
      const method = [...route.methods][0];
      const request = new Request(base + path, { method });
      assert.equal((await shared.fetch(request, other)).status, 403);
    }
    const get = () => shared.fetch(new Request(base + '/api/task-radar/radar'), owner);
    const first = await get();
    assert.equal(first.status, 200);
    const initial = await first.json();
    assert.equal(initial.ok, true);
    const changed = { ...initial.config, titlePrefix: 'Connection integration fixture', cooldownMs: 4321 };
    const post = await shared.fetch(new Request(base + '/api/task-radar/config', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ config: changed }),
    }), owner);
    assert.equal(post.status, 200);
    assert.equal((await post.json()).config.titlePrefix, changed.titlePrefix);
    assert.equal((await (await get()).json()).config.cooldownMs, 4321);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).titlePrefix, changed.titlePrefix);
    assert.equal((await shared.fetch(new Request(base + '/api/task-radar/radar/extra'), owner)).status, 404);
    assert.equal((await shared.fetch(new Request(base + '/api/task-radar/config'), owner)).status, 404);
    assert.equal(shared.requestBodyMode({ method: 'POST', url: new URL(base + '/api/task-radar/config') }), 'streaming');
    const before = sends.length;
    const toast = await shared.fetch(new Request(base + '/api/task-radar/test', { method: 'POST' }), owner);
    assert.equal(toast.status, 200);
    assert.equal((await toast.json()).submitted, true);
    assert.equal(sends.length, before + 1);
    await other.dispose();
    await owner.dispose();
    console.log('PASS real owner Peer shared Fetch GET + POST persist/readback; non-owner=403; exact matching=404; test sender');
    await radarFiber.dispose();
    await until(() => connection.fetchRoutes.size === 0, 'Fetch routes removed on plugin unload');
    await connectionFiber.dispose();
    assert.equal(rawRoutes.size, 0);
    console.log('PASS unload removes Fetch and HTTP carrier routes');
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    for (const fiber of fibers.reverse()) await fiber.dispose();
    // Root contexts own only synthetic services; their registry handles teardown.
    for (const ctx of contexts) if (typeof ctx.registry.dispose === 'function') await ctx.registry.dispose();
    record = undefined;
    if (oldConfig === undefined) delete process.env.TASK_RADAR_CONFIG_FILE;
    else process.env.TASK_RADAR_CONFIG_FILE = oldConfig;
    rmSync(directory, { recursive: true, force: true });
  }
  console.log('PASS cleanup: random loopback listener closed; temporary state removed; memory credentials discarded');
}
