/**
 * Host entry point for dsh-plugin-task-radar.
 *
 * Thin Cordis plugin shell wiring config persistence, lifecycle tracking,
 * Windows Toast, generic webhook, and authenticated Connection Fetch routes,
 * while re-exporting the complete public API for tests and consumers.
 *
 * ASCII only.
 * @module dsh-plugin-task-radar
 */

import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';

import { statePath } from './state-dir.js';
import { writeJsonAtomicSync } from './json-store.js';
import { normalizeConfig } from './config.js';
import { readConfigFile } from './config-file.js';
import { adaptHandler } from './fetch-handler.js';
import { TOAST_PROCESS_TIMEOUT_MS, createToastSender, fireToast } from './toast.js';
import { WEBHOOK_TIMEOUT_MS, createWebhookSender, fireWebhook } from './webhook.js';
import {
  REASON_KIND,
  resolveWorkspaceLabel,
  resolveSessionLabel,
  composeLocation,
  summarizePrompt,
  extractQuestion,
  createLifecycle,
} from './lifecycle.js';
import {
  PROFILE,
  version,
  REQUEST_BODY_TIMEOUT_MS,
  REQUEST_BODY_LIMIT,
  readBody,
  createHandler,
} from './routes.js';

export const name = 'dsh-plugin-task-radar';
/** Native notifications work without a browser carrier. */
export const inject = [];

export {
  version,
  TOAST_PROCESS_TIMEOUT_MS,
  createToastSender,
  fireToast,
  WEBHOOK_TIMEOUT_MS,
  createWebhookSender,
  fireWebhook,
  REQUEST_BODY_TIMEOUT_MS,
  REQUEST_BODY_LIMIT,
  createHandler,
};

/** Config file path. Overridable via TASK_RADAR_CONFIG_FILE for tests / alternate volumes. */
export function configFilePath() {
  const override = process.env.TASK_RADAR_CONFIG_FILE;
  if (typeof override === 'string' && override.trim() !== '') return override.trim();
  return statePath('task-radar', 'config.json');
}

/** Atomic write via shared json-store, refusing to replace an existing directory. */
function writeConfigFile(file, value) {
  try {
    if (statSync(file).isDirectory()) {
      throw new Error('config path is a directory');
    }
  } catch (error) {
    if (error && error.code !== 'ENOENT') throw error;
  }
  writeJsonAtomicSync(file, value, { spaces: 2 });
}

export function apply(ctx, options = {}) {
  const pluginLifetime = new AbortController();
  ctx.effect(() => () => {
    pluginLifetime.abort();
  }, 'task-radar lifetime');

  // Only function-valued overrides affect execution; persisted config stays data.
  const toastSender = options && typeof options.toastSender === 'function'
    ? options.toastSender
    : createToastSender({ signal: pluginLifetime.signal });
  const webhookSender = options && typeof options.webhookSender === 'function'
    ? options.webhookSender
    : createWebhookSender({ signal: pluginLifetime.signal });
  const nowOf = options && typeof options.now === 'function' ? options.now : Date.now;

  const file = configFilePath();
  const stored = readConfigFile(file);
  let cfg = normalizeConfig(stored);
  let configVersion = 1;

  // schema 1 snapshots stored the old defaults: sticky toasts plus a second browser
  // notification. Move those installs to the usable defaults once; later saves keep schema 2.
  if (stored && typeof stored === 'object' && !Array.isArray(stored) && Object.keys(stored).length > 0 && stored.schema !== 2) {
    cfg.toast.persistent = false;
    cfg.system.enabled = false;
    cfg.page.enabled = true;
    try { writeConfigFile(file, cfg); } catch { /* keep the migrated config in memory */ }
  }

  function persist(next) {
    const candidate = normalizeConfig(next);
    // Publish only after the atomic replacement succeeds. A failed save keeps
    // both active notification behavior and the last durable config unchanged.
    writeConfigFile(file, candidate);
    cfg = candidate;
    configVersion += 1;
  }

  const journalId = randomUUID();
  const lifecycle = createLifecycle({
    ctx,
    getCfg: () => cfg,
    toastSender,
    webhookSender,
    nowOf,
  });

  lifecycle.seedRunningAgents();

  // Register listeners inside ctx.effect so disposers can never hit a TDZ.
  ctx.effect(() => {
    const offStatus = ctx.on('agent/status', lifecycle.onStatus);
    const offSession = ctx.on('session/event', lifecycle.onSessionEvent);
    const offDisposed = ctx.on('agent/disposed', lifecycle.onDisposed);
    return () => {
      offStatus();
      offSession();
      offDisposed();
      lifecycle.states.clear();
    };
  }, 'task-radar lifecycle listeners');

  // Connection owns authenticated routes across browser and shell carriers.
  // Raw webServer routes would skip its Host/Origin and Peer checks.
  ctx.inject(['connection'], (scoped) => {
    const connection = typeof scoped.get === 'function' ? scoped.get('connection') : scoped.connection;
    if (!connection) return;
    scoped.effect(() => {
      const lifetime = new AbortController();
      const handler = createHandler(
        () => cfg,
        persist,
        lifecycle.journal,
        file,
        (_ctx, current, payload) => toastSender(ctx, current, payload),
        journalId,
        lifetime.signal,
        lifecycle.activeNow,
        () => configVersion,
      );
      const fetch = adaptHandler(handler);
      const unregister = [];
      const stop = async () => {
        lifetime.abort();
        await Promise.allSettled(unregister.splice(0).map((off) => {
          try { return off(); } catch (error) { return Promise.reject(error); }
        }));
      };
      try {
        for (const [path, methods] of [['radar', ['GET', 'HEAD']], ['config', ['POST']], ['test', ['POST']]]) {
          unregister.push(connection.fetch.register({
            path: PROFILE + '/' + path,
            methods,
            requestBody: path === 'radar' ? 'buffered' : 'streaming',
            fetch,
          }));
        }
      } catch (error) {
        void stop();
        throw error;
      }
      return stop;
    }, 'task-radar routes');
  });
}

export const __internals = {
  PROFILE,
  REASON_KIND,
  resolveWorkspaceLabel,
  resolveSessionLabel,
  composeLocation,
  summarizePrompt,
  extractQuestion,
  readBody,
  createHandler,
};
