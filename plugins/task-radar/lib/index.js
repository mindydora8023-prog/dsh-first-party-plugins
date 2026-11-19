/**
 * Lifecycle and native Toast engine adapted from Pasumao/dsh-plugin-notify.
 * Copyright (c) 2026 Pasumao. MIT; see ../THIRD_PARTY_NOTICES.md and ../licenses/.
 * Host half of dsh-plugin-task-radar.
 *
 * Watches the lifecycle event firehose and fans one turn start/finish out to two
 * channels:
 *
 *   - native Windows toast (this host half, zero-dependency, PowerShell 5.1
 *     ToastNotificationManager -- -EncodedCommand, env-passed strings, sanitized
 *     subprocess env);
 *   - browser OS notification (the client half): it cannot see host events, so a
 *     bounded in-memory journal is exposed at GET /api/task-radar/radar for the
 *     client to poll and turn into `new Notification(...)`.
 *
 * The "workspace . session" location line is resolved from workspaceRegistry +
 * sessionTitle / session/title (best-effort; omitted when unavailable).
 *
 * Detection contract (do-nothing is always safe):
 *   - agent/status running -> idle is the "no longer running" edge; the reason
 *     comes from the last turn/end we saw for that session.
 *   - tool/call ask_user_question while running fires `waiting` immediately.
 *   - agent/disposed while running fires `waiting` (session closed mid-run).
 * @module dsh-plugin-task-radar
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

import { statePath } from './state-dir.js';
import { DEFAULT_CONFIG, KIND_LABELS, inQuietHours, normalizeConfig } from './config.js';
import { readConfigFile, CONFIG_FILE_MAX_BYTES } from './config-file.js';
import { adaptHandler } from './fetch-handler.js';

export const name = 'dsh-plugin-task-radar';
export const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

/** Native notifications work without a browser carrier. */
export const inject = [];

const PROFILE = '/api/task-radar';
const JOURNAL_LIMIT = 24;

// -- paths -----------------------------------------------------------------

export function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh');
}

/** Config file path. Overridable via TASK_RADAR_CONFIG_FILE for tests / alternate volumes. */
export function configFilePath() {
  const override = process.env.TASK_RADAR_CONFIG_FILE;
  if (typeof override === 'string' && override.trim() !== '') return override.trim();
  return statePath('task-radar', 'config.json');
}

/** Atomic write: tmp then rename, so a crash never leaves a half file. */
function writeConfigFile(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = file + '.' + randomUUID() + '.tmp';
  let created = false;
  try {
    const fd = openSync(tmp, 'wx', 0o600);
    created = true;
    try {
      writeFileSync(fd, JSON.stringify(value, null, 2), 'utf8');
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
  } finally {
    if (created) {
      try { unlinkSync(tmp); } catch { /* renamed or cleanup unavailable */ }
    }
  }
}

// -- toast (Windows) -------------------------------------------------------

function defaultPowershellPath(env = process.env) {
  const windir = env.windir || env.WINDIR || 'C:\\Windows';
  return join(windir, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function defaultIconPath() {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'icon.png');
}

function sanitizedEnv(extra, parentEnv = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(parentEnv)) {
    if (/KEY|SECRET|TOKEN|PASSWORD/i.test(key)) continue;
    env[key] = value;
  }
  return Object.assign(env, extra);
}

const TOAST_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
function XmlEscape([string]$s) { return [System.Security.SecurityElement]::Escape($s) }
$title = [string]$env:TR_TITLE
$body = [string]$env:TR_BODY
$location = [string]$env:TR_LOCATION
$icon = [string]$env:TR_ICON
$persist = [string]$env:TR_PERSIST
$duration = [string]$env:TR_DURATION
$aumid = [string]$env:TR_AUMID
$seconds = 8
if ($duration -match '^\d+$') { $seconds = [int]$duration }
if ($seconds -lt 3) { $seconds = 3 }
if ($seconds -gt 30) { $seconds = 30 }
$durationAttr = ''
if ($persist -ne '1') {
  $banner = 'short'
  if ($seconds -gt 10) { $banner = 'long' }
  $durationAttr = ' duration="' + $banner + '"'
}
$iconPart = ''
if ($icon -and (Test-Path -LiteralPath $icon)) {
  $u = [System.Uri]::new($icon).AbsoluteUri
  $iconPart = '<image placement="appLogoOverride" src="' + (XmlEscape $u) + '" hint-crop="circle"/>'
}
$locPart = ''
if ($location) { $locPart = '<text>' + (XmlEscape $location) + '</text>' }
$scenario = ''
if ($persist -eq '1') { $scenario = ' scenario="reminder"' }
$xmlText = '<toast' + $scenario + $durationAttr + ' activationType="background"><visual><binding template="ToastGeneric">' + $iconPart + '<text>' + (XmlEscape $title) + '</text><text>' + (XmlEscape $body) + '</text>' + $locPart + '</binding></visual></toast>'
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml($xmlText)
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
if ($persist -ne '1') { $toast.ExpirationTime = [DateTimeOffset]::Now.AddSeconds($seconds) }
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($aumid).Show($toast)
`.trim();

const DEFAULT_AUMID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';

function toastSeconds(toast) {
  const n = toast && Number(toast.durationMs);
  if (!Number.isFinite(n) || n <= 0) return 8;
  return Math.max(3, Math.min(30, Math.round(n / 1000)));
}

export const TOAST_PROCESS_TIMEOUT_MS = 10000;

/** Inject process boundaries so tests never start PowerShell or display a toast. */
export function createToastSender({
  platform = process.platform,
  spawnProcess = spawn,
  fileExists = existsSync,
  environment = () => process.env,
} = {}) {
  return function sendToast(ctx, cfg, payload) {
    if (platform !== 'win32') return false;
    const warn = (message) => {
      if (ctx.logger && ctx.logger.warn) ctx.logger.warn(message);
    };
    try {
      const parentEnv = environment();
      const ps = defaultPowershellPath(parentEnv);
      const iconOverride = cfg.toast && typeof cfg.toast.iconPath === 'string' ? cfg.toast.iconPath.trim() : '';
      const iconCandidate = iconOverride !== '' ? iconOverride : defaultIconPath();
      const icon = fileExists(iconCandidate) ? iconCandidate : '';
      const encoded = Buffer.from(TOAST_SCRIPT, 'utf16le').toString('base64');
      const child = spawnProcess(ps, ['-NoProfile', '-STA', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], {
        env: sanitizedEnv({
          TR_TITLE: payload.title,
          TR_BODY: payload.body,
          TR_LOCATION: payload.location || '',
          TR_ICON: icon,
          TR_PERSIST: cfg.toast && cfg.toast.persistent ? '1' : '',
          TR_DURATION: String(toastSeconds(cfg.toast)),
          TR_AUMID: DEFAULT_AUMID,
        }, parentEnv),
        windowsHide: true,
        stdio: 'ignore',
        timeout: TOAST_PROCESS_TIMEOUT_MS,
        killSignal: 'SIGKILL',
      });
      child.once('error', (error) => warn('task-radar: toast process error: ' + String(error)));
      child.once('exit', (code, signal) => {
        if (signal || (code !== null && code !== 0)) {
          warn('task-radar: toast process exited: ' + String(code) + (signal ? ' (' + signal + ')' : ''));
        }
      });
      return true;
    } catch (error) {
      warn('task-radar: failed to launch toast: ' + String(error));
      return false;
    }
  };
}

const defaultToastSender = createToastSender();
export function fireToast(ctx, cfg, payload) {
  return defaultToastSender(ctx, cfg, payload);
}

// -- labels ----------------------------------------------------------------

function truncate(text, max) {
  if (typeof text !== 'string') return '';
  return text.length <= max ? text : text.slice(0, max) + '\u2026';
}

function pathBasename(path) {
  if (typeof path !== 'string' || !path) return '';
  return String(path).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
}

function resolveWorkspaceLabel(ctx, session) {
  const id = session && session.id;
  try {
    const registry = ctx.workspaceRegistry;
    if (registry && typeof registry.list === 'function') {
      const workspaces = registry.list();
      if (Array.isArray(workspaces)) {
        const match = workspaces.find((ws) => ws && Array.isArray(ws.sessionIds) && id != null && ws.sessionIds.includes(id));
        if (match) {
          const label = String(match.title || pathBasename(match.path) || '').trim();
          if (label) return truncate(label, 40);
        }
      }
    }
  } catch { /* ignore */ }
  return truncate(pathBasename(session && session.header && session.header.cwd), 40);
}

function resolveSessionLabel(ctx, session) {
  try {
    const snapshot = ctx.sessionTitle && ctx.sessionTitle.get ? ctx.sessionTitle.get(session) : undefined;
    const title = snapshot && snapshot.title;
    if (typeof title === 'string' && title.trim()) return truncate(title.trim(), 40);
  } catch { /* ignore */ }
  try {
    const events = session && session.events;
    if (Array.isArray(events)) {
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event && event.type === 'session/title' && event.data && typeof event.data.title === 'string' && event.data.title.trim()) {
          return truncate(event.data.title.trim(), 40);
        }
      }
    }
  } catch { /* ignore */ }
  if (session && typeof session.id === 'string' && session.id) return '#' + session.id.slice(0, 8);
  return '';
}

function composeLocation(workspace, sessionLabel) {
  const parts = [];
  if (workspace) parts.push('\u5de5\u4f5c\u533a\u300c' + workspace + '\u300d');
  if (sessionLabel) parts.push('\u4f1a\u8bdd\u300c' + sessionLabel + '\u300d');
  return truncate(parts.join(' \u00b7 '), 96);
}

function summarizePrompt(message, maxChars) {
  const blocks = message && message.content;
  if (!Array.isArray(blocks)) return '';
  for (const block of blocks) {
    if (block && block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
      return truncate(block.text.replace(/\s+/g, ' ').trim(), maxChars);
    }
  }
  return '';
}

function extractQuestion(rawArguments) {
  try {
    const parsed = JSON.parse(rawArguments);
    const question = Array.isArray(parsed && parsed.questions)
      ? parsed.questions.find((item) => item && typeof item.question === 'string' && item.question)
      : null;
    return question ? truncate(question.question, 80) : '';
  } catch {
    return '';
  }
}

function kindText(kind) {
  const map = {
    turnStart: '\u5f00\u59cb\u8fd0\u884c',
    finished: '\u5df2\u5b8c\u6210',
    aborted: '\u5df2\u4e2d\u6b62',
    error: '\u6267\u884c\u51fa\u9519',
    waiting: '\u7b49\u5f85\u4f60\u786e\u8ba4',
  };
  return map[kind] || kind;
}

/** turn/end reason kind -> normalized event kind. */
const REASON_KIND = {
  completed: 'finished',
  aborted: 'aborted',
  error: 'error',
  interrupted: 'aborted',
  'max-tokens': 'error',
  blocked: 'aborted',
};

// -- plugin ----------------------------------------------------------------

export function apply(ctx, options = {}) {
  // Only function-valued overrides affect execution; persisted config stays data.
  const toastSender = options && typeof options.toastSender === 'function' ? options.toastSender : fireToast;
  const nowOf = options && typeof options.now === 'function' ? options.now : Date.now;
  const file = configFilePath();
  const stored = readConfigFile(file);
  let cfg = normalizeConfig(stored);
  // schema 1 snapshots stored the old defaults: sticky toasts plus a second browser
  // notification. Move those installs to the usable defaults once; later saves keep schema 2.
  // A missing or unreadable file comes back as {}. Do not create one just to
  // record the new defaults; only an existing snapshot is migrated once.
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
  }

  const journal = [];
  const journalId = randomUUID();
  const states = new Map();
  // Cap per-agent state so a long-lived host that never fires agent/disposed for
  // some sessions cannot grow this Map without bound. Evict the oldest entry
  // that is not currently running.
  const MAX_STATES = 500;

  function stateFor(id) {
    let state = states.get(id);
    if (!state) {
      state = { running: false, turnStarted: false, lastReason: null, lastPrompt: '', waiting: false, waitingCallId: null, waitingText: '', session: null, lastAt: {} };
      states.set(id, state);
      if (states.size > MAX_STATES) {
        for (const [key, value] of states) {
          if (key !== id && value.running !== true) { states.delete(key); break; }
        }
      }
    }
    return state;
  }

  function isRoot(session) {
    const header = session && session.header;
    if (header && header.origin === 'subagent') return false;
    const depth = header && header.delegationDepth;
    return depth == null || depth === 0;
  }
  function tracked(session) {
    return cfg.rootsOnly ? isRoot(session) : true;
  }

  let journalSequence = 0;
  function pushJournal(entry) {
    journal.push({ ...entry, sequence: ++journalSequence });
    while (journal.length > JOURNAL_LIMIT) journal.shift();
  }

  /** Build the shared payload, push to the journal, and fire the host toast. */
  function emit(kind, state, session) {
    if (!cfg.enabled) return;
    if (cfg.events[kind] === false) return;
    const id = session && session.id != null ? String(session.id) : (state && state.id) || '';
    const now = nowOf();
    if (inQuietHours(cfg.quiet, new Date(now))) return;
    if (state) {
      const last = state.lastAt && state.lastAt[kind];
      if (typeof last === 'number' && now >= last && now - last < cfg.cooldownMs) return;
      state.lastAt = state.lastAt || {};
      state.lastAt[kind] = now;
    }
    const when = new Date(now).toLocaleTimeString('zh-CN', { hour12: false });
    const live = session || (state && state.session) || null;
    const workspace = live ? resolveWorkspaceLabel(ctx, live) : '';
    const sessionLabel = live ? resolveSessionLabel(ctx, live) : '';
    const location = composeLocation(workspace, sessionLabel);
    const prompt = state && state.lastPrompt ? '\u300c' + state.lastPrompt + '\u300d' : '\u4efb\u52a1';
    const label = KIND_LABELS[kind] || kind;
    const title = cfg.titlePrefix + ' \u00b7 ' + label;
    let body;
    if (kind === 'waiting') {
      body = state && state.waitingText
        ? 'Agent \u6b63\u5728\u7b49\u4f60\u9009\u62e9\uff1a' + state.waitingText
        : '\u7b49\u5f85\u4f60\u786e\u8ba4\uff08' + when + '\uff09';
    } else {
      body = prompt + ' ' + kindText(kind) + '\uff08' + when + '\uff09';
    }

    pushJournal({ at: now, kind, title, body, location, session: id });
    if (cfg.toast.enabled) toastSender(ctx, cfg, { title, body, location });
    if (ctx.logger && ctx.logger.debug) ctx.logger.debug('task-radar: ' + kind + ' -> ' + title + (location ? ' (' + location + ')' : ''));
  }

  // -- lifecycle wiring ----------------------------------------------------

  function onStatus(payload) {
    const agent = payload && payload.agent;
    const status = payload && payload.status;
    if (!agent || !tracked(agent.session)) return;
    const state = stateFor(agent.id);
    state.id = agent.id;
    state.session = agent.session || state.session;
    if (status === 'running') {
      const wasRunning = state.running;
      state.running = true;
      if (!wasRunning) {
        // Running is published before the next user/message is admitted. Never
        // describe a new run using the previous run's prompt or question.
        state.lastPrompt = '';
        state.lastReason = null;
        state.waiting = false;
        state.waitingCallId = null;
        state.waitingText = '';
        if (cfg.events.turnStart) emit('turnStart', state, agent.session);
      }
      return;
    }
    if (!state.running) return;
    state.running = false;
    const active = state.turnStarted || state.waiting;
    const kind = REASON_KIND[state.lastReason] || 'finished';
    state.turnStarted = false;
    state.lastReason = null;
    state.waiting = false;
    state.waitingCallId = null;
    state.waitingText = '';
    if (!active) return;
    emit(kind, state, agent.session);
  }

  function onSessionEvent(session, event) {
    if (!session || !tracked(session)) return;
    const state = stateFor(session.id);
    state.id = session.id;
    state.session = session;
    switch (event && event.type) {
      case 'turn/start':
        state.turnStarted = true;
        break;
      case 'turn/end':
        state.lastReason = event.data && event.data.reason ? event.data.reason.kind : null;
        break;
      case 'user/message': {
        // Current DSH stores the UserMessage itself; accept the historical
        // wrapper too. Injected runtime/skill context must not rename the task.
        const message = event.data && (event.data.message || event.data);
        if (message && (!message.source || message.source.kind === 'user')) {
          state.lastPrompt = summarizePrompt(message, cfg.summaryMaxChars);
        }
        break;
      }
      case 'tool/call': {
        const call = event.data;
        if (call && call.name === 'ask_user_question') {
          state.waiting = true;
          state.waitingCallId = call.callId;
          state.waitingText = extractQuestion(call.arguments);
          if (state.running) emit('waiting', state, session);
        }
        break;
      }
      case 'tool/result': {
        const result = event.data;
        const message = result && result.message;
        const callId = message && (message.toolCallId ?? (message.source && message.source.callId) ?? message.callId);
        if (state.waiting && callId != null && callId === state.waitingCallId) {
          state.waiting = false;
          state.waitingCallId = null;
          state.waitingText = '';
        }
        break;
      }
      default:
        break;
    }
  }

  function onDisposed(payload) {
    const agent = payload && payload.agent;
    if (!agent) return;
    const state = states.get(agent.id);
    if (!state) return;
    const wasRunning = state.running;
    states.delete(agent.id);
    if (wasRunning && tracked(agent.session || state.session)) emit('waiting', state, agent.session);
  }

  // Seed: existing running agents are treated as active so their finish notifies.
  try {
    const agents = ctx.agents && ctx.agents.list ? ctx.agents.list() : undefined;
    if (Array.isArray(agents)) {
      for (const agent of agents) {
        if (agent && tracked(agent.session) && agent.status === 'running') {
          const state = stateFor(agent.id);
          state.id = agent.id;
          state.session = agent.session;
          state.running = true;
          state.turnStarted = true;
        }
      }
    }
  } catch { /* ignore */ }

  ctx.effect(() => () => {
    offStatus();
    offSession();
    offDisposed();
    states.clear();
  }, 'task-radar lifecycle listeners');
  const offStatus = ctx.on('agent/status', onStatus);
  const offSession = ctx.on('session/event', onSessionEvent);
  const offDisposed = ctx.on('agent/disposed', onDisposed);

  // -- routes --------------------------------------------------------------

  // Connection owns authenticated routes across browser and shell carriers.
  // Raw webServer routes would skip its Host/Origin and Peer checks.
  ctx.inject(['connection'], (scoped) => {
    const connection = typeof scoped.get === 'function' ? scoped.get('connection') : scoped.connection;
    if (!connection) return;
    scoped.effect(() => {
      const lifetime = new AbortController();
      const activeNow = () => {
        for (const state of states.values()) {
          if (state.running === true || state.waiting === true) return true;
        }
        return false;
      };
      const handler = createHandler(() => cfg, persist, journal, file, (_ctx, current, payload) => toastSender(ctx, current, payload), journalId, lifetime.signal, activeNow);
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
          unregister.push(connection.fetch.register({ path: PROFILE + '/' + path, methods, requestBody: path === 'radar' ? 'buffered' : 'streaming', fetch }));
        }
      } catch (error) {
        void stop();
        throw error;
      }
      return stop;
    }, 'task-radar routes');
  });
}

function json(res, status, value, { head = false, close = false } = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body), ...(close ? { connection: 'close' } : {}) });
  res.end(head ? undefined : body);
}

export const REQUEST_BODY_TIMEOUT_MS = 10000;
export const REQUEST_BODY_LIMIT = CONFIG_FILE_MAX_BYTES;

class RequestBodyError extends Error {
  constructor(status, reason) {
    super(reason);
    this.status = status;
    this.reason = reason;
  }
}

function readBody(req, limit, timeoutMs = REQUEST_BODY_TIMEOUT_MS, signal) {
  return new Promise((resolve, reject) => {
    if (req.aborted || (req.destroyed && !req.readableEnded)) {
      reject(new RequestBodyError(400, 'request-aborted'));
      return;
    }
    if (signal && signal.aborted) {
      reject(new RequestBodyError(503, 'plugin-unloaded'));
      return;
    }
    let size = 0;
    let settled = false;
    const chunks = [];
    const timer = setTimeout(() => fail(408, 'request-timeout'), timeoutMs);
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      if (error) {
        chunks.length = 0;
        req.pause();
        reject(error);
      } else {
        resolve(Buffer.concat(chunks).toString('utf8'));
        chunks.length = 0;
      }
      // Keep the error observer until close: IncomingMessage can emit an
      // ECONNRESET after aborted or after a response closes an unread upload.
      if (req.destroyed) detach();
    }
    function fail(status, reason) { finish(new RequestBodyError(status, reason)); }
    function detach() {
      req.removeListener('error', onError);
      req.removeListener('close', onClose);
    }
    function onAbort() { fail(503, 'plugin-unloaded'); }
    function onError() { fail(400, req.aborted ? 'request-aborted' : 'request-read-error'); }
    function onClose() {
      fail(400, 'request-aborted');
      detach();
    }
    function onEnd() { finish(); }
    function onData(chunk) {
      if (settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > limit) { fail(413, 'body-too-large'); return; }
      chunks.push(bytes);
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    req.on('error', onError);
    req.on('close', onClose);
    req.on('end', onEnd);
    req.on('data', onData);
    const declared = Number(req.headers && req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) fail(413, 'body-too-large');
  });
}

export function createHandler(getCfg, persist, journal, file, toastSender = fireToast, journalId = randomUUID(), signal, activeNow = () => false) {
  return async (req, res) => {
    if (signal && signal.aborted) {
      json(res, 503, { ok: false, reason: 'plugin-unloaded' }, { close: true });
      return;
    }
    let url;
    try {
      url = new URL(req.url || '/', 'http://api/task-radar.invalid');
    } catch {
      json(res, 400, { ok: false, reason: 'bad-url' });
      return;
    }
    const path = url.pathname;
    const method = (req.method || 'GET').toUpperCase();

    try {
      if (path === PROFILE + '/radar' && (method === 'GET' || method === 'HEAD')) {
        // `active` lets a page poll slowly while nothing is running. Windows
        // Toast does not use this route; the browser notification does.
        let active = false;
        try { active = activeNow() === true; } catch { active = false; }
        // A page that already has every entry does not need the journal or the
        // config again. Windows Toast does not use this response at all.
        let newest = 0;
        for (const entry of journal) {
          if (entry && Number.isSafeInteger(entry.sequence) && entry.sequence > newest) newest = entry.sequence;
        }
        const since = Number(url.searchParams.get('since'));
        if (Number.isFinite(since) && since > 0 && newest <= since) {
          json(res, 200, { ok: true, version, journalId, active, sequence: newest, unchanged: true }, { head: method === 'HEAD' });
          return;
        }
        json(res, 200, { ok: true, version, journalId, active, sequence: newest, journal: journal.slice(), config: getCfg() }, { head: method === 'HEAD' });
        return;
      }
      if (path === PROFILE + '/config' && method === 'POST') {
        const raw = await readBody(req, REQUEST_BODY_LIMIT, REQUEST_BODY_TIMEOUT_MS, signal);
        if (req.aborted) return;
        if (signal && signal.aborted) throw new RequestBodyError(503, 'plugin-unloaded');
        let incoming;
        try {
          incoming = JSON.parse(raw);
        } catch {
          json(res, 400, { ok: false, reason: 'bad-json' });
          return;
        }
        const candidate = incoming && Object.hasOwn(incoming, 'config') ? incoming.config : incoming;
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
          json(res, 400, { ok: false, reason: 'invalid-config' });
          return;
        }
        persist(candidate);
        json(res, 200, { ok: true, config: getCfg(), file });
        return;
      }
      if (path === PROFILE + '/test' && method === 'POST') {
        const cfg = getCfg();
        const title = cfg.titlePrefix + ' \u00b7 \u6d4b\u8bd5\u901a\u77e5';
        const body = '\u6d4b\u8bd5\u901a\u77e5\u8bf7\u6c42\u5df2\u63d0\u4ea4\uff0c\u8bf7\u5728 Windows \u901a\u77e5\u4e2d\u6838\u5bf9\u3002';
        const submitted = cfg.toast.enabled
          ? toastSender({ logger: { warn() {} } }, cfg, { title, body, location: '' }) === true
          : false;
        json(res, 200, { ok: true, submitted });
        return;
      }
      json(res, 404, { ok: false, reason: 'not-found' });
    } catch (error) {
      if (req.aborted || res.destroyed || res.writableEnded) return;
      if (error instanceof RequestBodyError) {
        json(res, error.status, { ok: false, reason: error.reason }, { close: true });
        return;
      }
      json(res, 500, { ok: false, reason: 'internal', message: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300) });
    }
  };
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
  DEFAULT_CONFIG,
};
