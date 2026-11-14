/**
 * Host-half integration tests: route registration ordering and name filtering.
 *
 * The production failure this guards against was silent: the plugin asked
 * `ctx.get('webServer')` once during activation, got `undefined` because the
 * service was not up yet, and returned without ever registering the route. The
 * only symptom was "the pill says unpriced forever". So these tests drive a real
 * `apply()` against a fake Cordis context whose `webServer` arrives late, and a
 * real local HTTP server standing in for models.dev and the FX endpoint.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { apply } from '../lib/index.js';

const CATALOG = {
  openai: { models: { 'gpt-6-sol': { cost: { input: 2, output: 10, cache_read: 0.2 } } } },
  // Present to prove the catalog never prices DeepSeek: the built-in table owns it.
  deepseek: { models: { 'deepseek-flash': { cost: { input: 0.15, output: 0.6 } } } },
};

/** One local server standing in for both upstream endpoints. */
async function withUpstream(body, options = {}) {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json; charset=utf-8');
    if ((req.url ?? '').startsWith('/catalog')) res.end(JSON.stringify(CATALOG));
    else res.end(JSON.stringify({ rates: { CNY: 7 } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const scratch = mkdtempSync(join(tmpdir(), 'session-meter-host-'));
  const statusFile = join(scratch, options.statusRel ?? 'status.json');
  // Isolate BOTH files: the machine's real price cache would make the plugin
  // serve yesterday's catalog instead of the fake upstream below.
  const cacheFile = join(scratch, 'prices.json');
  process.env.SESSION_METER_PRICES_URL = `${origin}/catalog`;
  process.env.SESSION_METER_FX_URL = `${origin}/fx`;
  process.env.SESSION_METER_STATUS_FILE = statusFile;
  process.env.SESSION_METER_CACHE_FILE = cacheFile;
  try {
    return await body({ origin, statusFile, cacheFile });
  } finally {
    delete process.env.SESSION_METER_PRICES_URL;
    delete process.env.SESSION_METER_FX_URL;
    delete process.env.SESSION_METER_STATUS_FILE;
    delete process.env.SESSION_METER_CACHE_FILE;
    await new Promise((resolve) => server.close(resolve));
    rmSync(scratch, { force: true, recursive: true });
  }
}

/** Minimal Cordis context: records effects (with their disposers) and the inject callback. */
function fakeContext() {
  const captured = { route: undefined, injectCallback: undefined, disposers: [] };
  const ctx = {
    logger: { warn() {} },
    effect(factory) {
      const dispose = factory();
      // The plugin arms an hourly timer; leaving it armed would keep the test
      // process alive forever, so every effect is disposed by the caller.
      captured.disposers.push(typeof dispose === 'function' ? dispose : () => {});
      return dispose;
    },
    get() {
      return undefined;
    },
    inject(deps, callback) {
      assert.deepEqual(deps, ['webServer']);
      captured.injectCallback = callback;
    },
  };
  return { ctx, captured };
}

/** Run one test body with its effects disposed afterwards. */
async function withPlugin(body) {
  const { ctx, captured } = fakeContext();
  try {
    apply(ctx);
    return await body(captured);
  } finally {
    for (const dispose of captured.disposers.reverse()) dispose();
  }
}

/** Pretend `webServer` appeared; remember the route the plugin registers. */
function attach(captured) {
  captured.injectCallback({
    get: () => ({
      register(spec) {
        captured.route = spec;
        return () => {};
      },
    }),
  });
  return captured.route;
}

function fakeResponse() {  const chunks = [];
  return {
    statusCode: 0,
    headers: undefined,
    writeHead(code, headers) {
      this.statusCode = code;
      this.headers = headers;
    },
    end(body) {
      chunks.push(body ?? '');
    },
    body() {
      return chunks.join('');
    },
  };
}

test('the price route waits for webServer instead of giving up', async () => {
  await withUpstream(async () => {
    await withPlugin(async (captured) => {
      assert.equal(captured.route, undefined, 'nothing may register before the service exists');
      assert.equal(typeof captured.injectCallback, 'function', 'activation waits through ctx.inject');

      captured.injectCallback({ get: () => ({ register: (spec) => { captured.route = spec; return () => {}; } }) });
      assert.notEqual(captured.route, undefined, 'the route appears once webServer arrives');
      assert.equal(captured.route.kind, 'exact');
      assert.equal(captured.route.path, '/session-meter/prices');
    });
  });
});

test('the route answers only the names it can price', async () => {
  await withUpstream(async () => {
    await withPlugin(async (captured) => {
      attach(captured);
      const res = fakeResponse();
      await captured.route.handler({
        method: 'GET',
        url: '/session-meter/prices?m=' + encodeURIComponent('codex/gpt-6.1-sol,deepseek-flash,relay/nope'),
      }, res);
      const payload = JSON.parse(res.body());
      assert.equal(res.statusCode, 200);
      assert.equal(payload.ok, true, 'payload: ' + res.body());
      assert.equal(payload.currency, 'CNY');
      // DeepSeek stays out of the catalog (built-in table), the unknown name is absent.
      assert.deepEqual(Object.keys(payload.models), ['codex/gpt-6.1-sol'], 'models: ' + res.body());
      // 2 USD x 7 CNY = 14 CNY per million input tokens.
      assert.equal(payload.models['codex/gpt-6.1-sol'].input, 14);
    });
  });
});

test('the status file records what happened, for the next "why unpriced" report', async () => {
  await withUpstream(async ({ statusFile }) => {
    await withPlugin(async (captured) => {
      attach(captured);
      const res = fakeResponse();
      await captured.route.handler({ method: 'GET', url: '/session-meter/prices?m=codex%2Fgpt-6.1-sol' }, res);
      const status = JSON.parse(readFileSync(statusFile, 'utf8'));
      assert.equal(status.web_server, true);
      assert.equal(status.route_registered, true);
      assert.equal(status.last_request_answered, true);
      assert.deepEqual(status.last_request_names, ['codex/gpt-6.1-sol']);
      assert.deepEqual(status.last_request_hits, ['codex/gpt-6.1-sol']);
      assert.equal(status.priced_models > 0, true);
      rmSync(statusFile, { force: true });
    });
  });
});

test('the status file directory is created on first write', async () => {
  // A clean profile has no %LOCALAPPDATA%/dsh-plugins/session-meter directory.
  // writeStatus must create it, or the diagnostic file silently never appears.
  await withUpstream(async ({ statusFile }) => {
    await withPlugin(async () => {
      assert.equal(existsSync(statusFile), true, 'status file must be created inside a fresh nested dir');
    });
  }, { statusRel: join('nested', 'deep', 'status.json') });
});

test('a stale cache answers immediately and refreshes behind the response', async () => {
  await withUpstream(async ({ cacheFile }) => {
    // Older than the 24 h window, so the route must treat it as stale.
    const staleAt = Date.now() - 48 * 3600 * 1000;
    writeFileSync(cacheFile, JSON.stringify({
      version: 2,
      fetchedAt: staleAt,
      usdToCny: 7,
      models: { 'cached-model': { input: 1, output: 2, cacheRead: 1, cacheWrite: 1 } },
    }));
    let catalogHits = 0;
    let releaseCatalog;
    const held = new Promise((resolve) => { releaseCatalog = resolve; });
    const server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json; charset=utf-8');
      if ((req.url ?? '').startsWith('/catalog')) {
        catalogHits += 1;
        held.then(() => res.end(JSON.stringify(CATALOG)));
      } else {
        res.end(JSON.stringify({ rates: { CNY: 7 } }));
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    process.env.SESSION_METER_PRICES_URL = `${origin}/catalog`;
    process.env.SESSION_METER_FX_URL = `${origin}/fx`;
    try {
      await withPlugin(async (captured) => {
        attach(captured);
        // Let the background refresh from apply() reach the held catalog first,
        // so the assertion below is about the request path, not about boot.
        await new Promise((resolve) => setTimeout(resolve, 50));
        const res = fakeResponse();
        const pending = captured.route.handler({
          method: 'GET',
          url: '/session-meter/prices?m=cached-model',
        }, res);
        const settled = await Promise.race([
          pending.then(() => 'answered'),
          new Promise((resolve) => setTimeout(() => resolve('blocked'), 200)),
        ]);
        assert.equal(settled, 'answered', 'a stale snapshot must not wait on the refresh');
        const payload = JSON.parse(res.body());
        assert.equal(payload.models['cached-model'].input, 1);
        assert.equal(catalogHits > 0, true, 'the refresh still starts');
        releaseCatalog();
        await pending;
      });
    } finally {
      releaseCatalog();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

test('a non-GET request is refused without touching the catalog', async () => {
  await withUpstream(async () => {
    await withPlugin(async (captured) => {
      attach(captured);
      const res = fakeResponse();
      await captured.route.handler({ method: 'POST', url: '/session-meter/prices' }, res);
      assert.equal(res.statusCode, 405);
    });
  });
});
