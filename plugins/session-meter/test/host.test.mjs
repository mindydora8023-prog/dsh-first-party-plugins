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
    if ((req.url ?? '').startsWith('/catalog')) {
      res.setHeader('etag', '"catalog-v1"');
      res.end(JSON.stringify(CATALOG));
    } else res.end(JSON.stringify({ rates: { CNY: 7 } }));
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
    // A snapshot rename can still be in flight. One rm then fails with ENOTEMPTY.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        rmSync(scratch, { force: true, recursive: true });
        break;
      } catch (error) {
        if (attempt === 9) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
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
  await withUpstream(async ({ cacheFile }) => {
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
      let saved;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        try {
          saved = JSON.parse(readFileSync(cacheFile, 'utf8'));
          if (saved.models && saved.models['gpt-6-sol']) break;
        } catch {
          // The snapshot is written after the response, through a temp file.
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(saved && saved.version, 3, 'the snapshot replaced the file, it was not truncated into it');
      assert.equal(existsSync(`${cacheFile}.tmp`), false, 'the temporary file does not linger');
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

test('a refresh replaces an existing snapshot instead of leaving it stale', async () => {
  await withUpstream(async ({ cacheFile }) => {
    writeFileSync(cacheFile, JSON.stringify({
      version: 3,
      fetchedAt: Date.now() - 48 * 3600 * 1000,
      usdToCny: 7,
      models: { 'old-model': { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } },
    }));
    await withPlugin(async () => {
      let saved;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        try {
          saved = JSON.parse(readFileSync(cacheFile, 'utf8'));
          if (saved.models && saved.models['gpt-6-sol']) break;
        } catch {
          // Caught between removing the old file and renaming the new one.
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(saved && saved.models['gpt-6-sol'].input, 14, 'the new catalog replaced the old file');
      assert.equal(saved.models['old-model'], undefined);
      assert.equal(existsSync(`${cacheFile}.tmp`), false);
    });
  });
});

test('a finished temp snapshot beats the main file it was about to replace', async () => {
  await withUpstream(async ({ cacheFile }) => {
    // A live refresh would replace both files before the assertion. Point the
    // fetch at a closed port so the loaded snapshot is what gets served.
    process.env.SESSION_METER_PRICES_URL = 'http://127.0.0.1:1/catalog';
    process.env.SESSION_METER_FX_URL = 'http://127.0.0.1:1/fx';
    const older = Date.now() - 3600 * 1000;
    writeFileSync(cacheFile, JSON.stringify({
      version: 3,
      fetchedAt: older,
      usdToCny: 7,
      models: { 'old-model': { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } },
    }));
    writeFileSync(`${cacheFile}.tmp`, JSON.stringify({
      version: 3,
      fetchedAt: Date.now(),
      usdToCny: 7,
      models: { 'new-model': { input: 6, output: 6, cacheRead: 6, cacheWrite: 6 } },
    }));
    await withPlugin(async (captured) => {
      attach(captured);
      const res = fakeResponse();
      await captured.route.handler({ method: 'GET', url: '/session-meter/prices?m=new-model' }, res);
      const payload = JSON.parse(res.body());
      assert.equal(payload.models['new-model'].input, 6, 'the temp file is newer than the main file');
      assert.equal(payload.models['old-model'], undefined);
      let rewritten = false;
      for (let attempt = 0; attempt < 40 && !rewritten; attempt += 1) {
        try {
          const saved = JSON.parse(readFileSync(cacheFile, 'utf8'));
          rewritten = saved.models && saved.models['new-model'] && saved.models['new-model'].input === 6;
        } catch {
          // The rewrite goes through the temp file.
        }
        if (!rewritten) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(rewritten, true, 'the newer snapshot is written back over the old main file');
    });
  });
});

test('a finished temp snapshot beats the older backup', async () => {
  await withUpstream(async ({ cacheFile }) => {
    writeFileSync(`${cacheFile}.tmp`, JSON.stringify({
      version: 3,
      fetchedAt: Date.now(),
      usdToCny: 7,
      models: { 'new-model': { input: 4, output: 4, cacheRead: 4, cacheWrite: 4 } },
    }));
    writeFileSync(`${cacheFile}.bak`, JSON.stringify({
      version: 3,
      fetchedAt: Date.now() - 86400000,
      usdToCny: 7,
      models: { 'old-model': { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } },
    }));
    await withPlugin(async (captured) => {
      attach(captured);
      const res = fakeResponse();
      await captured.route.handler({ method: 'GET', url: '/session-meter/prices?m=new-model' }, res);
      const payload = JSON.parse(res.body());
      assert.equal(payload.models['new-model'].input, 4, 'the temp file is the newer snapshot');
      assert.equal(payload.models['old-model'], undefined);
    });
  });
});

test('a missing snapshot is served from its backup', async () => {
  await withUpstream(async ({ cacheFile }) => {
    writeFileSync(`${cacheFile}.bak`, JSON.stringify({
      version: 3,
      fetchedAt: Date.now(),
      usdToCny: 7,
      models: { 'kept-model': { input: 9, output: 9, cacheRead: 9, cacheWrite: 9 } },
    }));
    await withPlugin(async (captured) => {
      attach(captured);
      const res = fakeResponse();
      await captured.route.handler({ method: 'GET', url: '/session-meter/prices?m=kept-model' }, res);
      const payload = JSON.parse(res.body());
      assert.equal(payload.models['kept-model'].input, 9, 'the backup is the snapshot when the file itself is gone');
      let restored = false;
      for (let attempt = 0; attempt < 40 && !restored; attempt += 1) {
        restored = existsSync(cacheFile);
        if (!restored) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(restored, true, 'the backup is moved back to the main path');
      assert.equal(JSON.parse(readFileSync(cacheFile, 'utf8')).models['kept-model'].input, 9);
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

test('a matching etag skips the catalog body and keeps the cached rates', async () => {
  await withUpstream(async ({ cacheFile, statusFile }) => {
    const staleAt = Date.now() - 48 * 3600 * 1000;
    writeFileSync(cacheFile, JSON.stringify({
      version: 3,
      fetchedAt: staleAt,
      usdToCny: 7,
      catalogEtag: '"catalog-v1"',
      models: { 'cached-model': { input: 3, output: 4, cacheRead: 3, cacheWrite: 3 } },
    }));
    let catalogBytes = 0;
    let sawValidator = false;
    const server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json; charset=utf-8');
      if ((req.url ?? '').startsWith('/catalog')) {
        sawValidator = req.headers['if-none-match'] === '"catalog-v1"';
        res.writeHead(304, { etag: '"catalog-v1"' });
        res.end();
      } else {
        catalogBytes += 1;
        res.end(JSON.stringify({ rates: { CNY: 7 } }));
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    process.env.SESSION_METER_PRICES_URL = `http://127.0.0.1:${server.address().port}/catalog`;
    process.env.SESSION_METER_FX_URL = `http://127.0.0.1:${server.address().port}/fx`;
    try {
      await withPlugin(async (captured) => {
        attach(captured);
        let status;
        for (let attempt = 0; attempt < 40; attempt += 1) {
          status = JSON.parse(readFileSync(statusFile, 'utf8'));
          if (status.last_refresh_not_modified === true) break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        const res = fakeResponse();
        await captured.route.handler({ method: 'GET', url: '/session-meter/prices?m=cached-model' }, res);
        const payload = JSON.parse(res.body());
        assert.equal(sawValidator, true, 'the stored etag is sent');
        assert.equal(status.last_error, null, '304 must not be reported as a failed refresh');
        assert.equal(status.last_refresh_not_modified, true);
        assert.equal(payload.models['cached-model'].input, 3, 'the cached rate survives a 304');
        assert.equal(payload.fetchedAt, staleAt, 'a revalidation is not a new catalog');
        const saved = JSON.parse(readFileSync(cacheFile, 'utf8'));
        assert.equal(saved.fetchedAt, staleAt, 'an unchanged catalog is not rewritten to disk');
        const again = fakeResponse();
        await captured.route.handler({ method: 'GET', url: '/session-meter/prices?m=cached-model' }, again);
        assert.equal(JSON.parse(again.body()).fetchedAt, staleAt, 'the next answer keeps the same catalog instant');
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

test('an identical price query reuses the response body', async () => {
  await withUpstream(async () => {
    await withPlugin(async (captured) => {
      attach(captured);
      const first = fakeResponse();
      const url = '/session-meter/prices?m=' + encodeURIComponent('codex/gpt-6.1-sol');
      await captured.route.handler({ method: 'GET', url }, first);
      const second = fakeResponse();
      await captured.route.handler({ method: 'GET', url }, second);
      assert.equal(first.headers['x-session-meter-cache'], 'miss');
      assert.equal(second.headers['x-session-meter-cache'], 'hit');
      assert.equal(second.body(), first.body());
      const other = fakeResponse();
      await captured.route.handler({
        method: 'GET',
        url: '/session-meter/prices?m=' + encodeURIComponent('relay/nope'),
      }, other);
      assert.equal(other.headers['x-session-meter-cache'], 'miss');
      const again = fakeResponse();
      await captured.route.handler({ method: 'GET', url }, again);
      assert.equal(again.headers['x-session-meter-cache'], 'hit', 'a different query must not evict the previous one');
      // Cache holds 8. It already has two. Fill to the cap, repeat the first
      // query so it is newest, then add two more: the one nobody repeated is
      // what gets dropped.
      for (let index = 0; index < 6; index += 1) {
        const extra = fakeResponse();
        await captured.route.handler({
          method: 'GET',
          url: '/session-meter/prices?m=' + encodeURIComponent('model-' + index),
        }, extra);
      }
      const kept = fakeResponse();
      await captured.route.handler({ method: 'GET', url }, kept);
      assert.equal(kept.headers['x-session-meter-cache'], 'hit');
      for (let index = 6; index < 8; index += 1) {
        const extra = fakeResponse();
        await captured.route.handler({
          method: 'GET',
          url: '/session-meter/prices?m=' + encodeURIComponent('model-' + index),
        }, extra);
      }
      const still = fakeResponse();
      await captured.route.handler({ method: 'GET', url }, still);
      assert.equal(still.headers['x-session-meter-cache'], 'hit', 'repeating a query keeps it');
      const dropped = fakeResponse();
      await captured.route.handler({
        method: 'GET',
        url: '/session-meter/prices?m=' + encodeURIComponent('relay/nope'),
      }, dropped);
      assert.equal(dropped.headers['x-session-meter-cache'], 'miss', 'the query that was not repeated is the one evicted');
    });
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
