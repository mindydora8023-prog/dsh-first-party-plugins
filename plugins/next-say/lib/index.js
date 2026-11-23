/**
 * Host half of dsh-plugin-next-say.
 *
 * Thin Cordis plugin entry point that allocates isolated per-instance runtime
 * state (`lib/turn.js`) and mounts the same-origin API routes (`lib/routes.js`).
 *
 * Source is kept pure ASCII (workspace convention).
 */
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { readSettings, settingsPath } from './config.js';
import {
  createRuntimeState,
  disposeRuntime,
  forgetSession,
  generate as runGenerate,
  historyOf,
  lastCompletedTurn as scanLastCompletedTurn,
} from './turn.js';
import {
  BODY_TIMEOUT_MS,
  ROUTE,
  createHandler as buildHandler,
  readJsonBody,
} from './routes.js';

function dshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv;
  const profile = process.env.DSH_PROFILE_DIR;
  if (typeof profile === 'string' && profile.trim() !== '') return dirname(profile);
  return join(homedir(), '.dsh');
}

export function apply(ctx) {
  const file = settingsPath(dshHome());
  const state = { file, settings: readSettings(file) };
  const runtime = createRuntimeState();

  ctx.effect(() => () => {
    disposeRuntime(runtime);
  }, 'next-say prediction cleanup');

  ctx.inject(['webServer'], (scoped) => {
    const handler = buildHandler(scoped, state, runtime);
    scoped.effect(
      () => scoped.webServer.register({ kind: 'prefix', path: ROUTE, handler }),
      'next-say routes',
    );
  });

  ctx.effect(
    () =>
      ctx.on('session/disposed', (session) => {
        let sessionId;
        try {
          sessionId = String(session.id);
        } catch {
          return;
        }
        forgetSession(runtime, sessionId);
      }),
    'next-say session cleanup',
  );
}

/**
 * Default runtime used only by unit tests exercising `__internals` directly
 * without going through `apply(ctx)`. Live plugin instances each own their own
 * isolated runtime created inside `apply(ctx)`.
 */
const defaultRuntime = createRuntimeState();

export const __internals = {
  ROUTE,
  BODY_TIMEOUT_MS,
  readJsonBody,
  createRuntimeState,
  createHandler(ctx, state, runtime = defaultRuntime) {
    return buildHandler(ctx, state, runtime);
  },
  inflight: defaultRuntime.inflight,
  deliveredTurns: defaultRuntime.deliveredTurns,
  memory: defaultRuntime.memory,
  historyOf,
  generate(ctx, session, settings, options = {}, runtime = defaultRuntime) {
    return runGenerate(ctx, session, settings, options, runtime);
  },
  lastCompletedTurn(session, runtime = defaultRuntime) {
    return scanLastCompletedTurn(session, runtime);
  },
  resetState() {
    for (const controller of defaultRuntime.inflight.values()) controller.abort();
    defaultRuntime.inflight.clear();
    defaultRuntime.attempts.clear();
    defaultRuntime.deliveredTurns.clear();
    defaultRuntime.scanCache.clear();
  },
};
