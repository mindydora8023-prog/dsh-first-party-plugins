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
 *     bounded in-memory journal is exposed at GET /task-radar/radar for the
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
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

import { statePath } from './state-dir.js';
import { DEFAULT_CONFIG, KIND_LABELS, normalizeConfig } from './config.js';

export const name = 'dsh-plugin-task-radar';
export const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

/** `webServer` is optional (route registered when present). */
export const inject = ['webServer'];

const PROFILE = '/task-radar';
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

function readConfigFile(file) {
  try {
    const raw = readFileSync(file, 'utf8');
    if (Buffer.byteLength(raw) > 256 * 1024) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** Atomic write: tmp then rename, so a crash never leaves a half file. */
function writeConfigFile(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  renameSync(tmp, file);
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
$aumid = [string]$env:TR_AUMID
$iconPart = ''
if ($icon -and (Test-Path -LiteralPath $icon)) {
  $u = [System.Uri]::new($icon).AbsoluteUri
  $iconPart = '<image placement="appLogoOverride" src="' + (XmlEscape $u) + '" hint-crop="circle"/>'
}
$locPart = ''
if ($location) { $locPart = '<text>' + (XmlEscape $location) + '</text>' }
$scenario = ''
if ($persist -eq '1') { $scenario = ' scenario="reminder"' }
$xmlText = '<toast' + $scenario + ' activationType="background"><visual><binding template="ToastGeneric">' + $iconPart + '<text>' + (XmlEscape $title) + '</text><text>' + (XmlEscape $body) + '</text>' + $locPart + '</binding></visual></toast>'
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml($xmlText)
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($aumid).Show($toast)
`.trim();

const DEFAULT_AUMID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';

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

  function persist(next) {
    cfg = normalizeConfig(next);
    try { writeConfigFile(file, cfg); } catch { /* persistence failure never breaks notify */ }
  }

  const journal = [];
  const states = new Map();

  function stateFor(id) {
    let state = states.get(id);
    if (!state) {
      state = { running: false, turnStarted: false, lastReason: null, lastPrompt: '', waiting: false, waitingCallId: null, waitingText: '', session: null, lastAt: {} };
      states.set(id, state);
    }
    return state;
  }

  function isRoot(session) {
    const depth = session && session.header && session.header.delegationDepth;
    return depth == null || depth === 0;
  }
  function tracked(session) {
    return cfg.rootsOnly ? isRoot(session) : true;
  }

  function pushJournal(entry) {
    journal.push(entry);
    while (journal.length > JOURNAL_LIMIT) journal.shift();
  }

  /** Build the shared payload, push to the journal, and fire the host toast. */
  function emit(kind, state, session) {
    if (!cfg.enabled) return;
    if (cfg.events[kind] === false) return;
    const id = session && session.id != null ? String(session.id) : (state && state.id) || '';
    const now = nowOf();
    if (state) {
      const last = (state.lastAt && state.lastAt[kind]) || 0;
      if (now - last < cfg.cooldownMs) return;
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
      if (!wasRunning && cfg.events.turnStart) emit('turnStart', state, agent.session);
      return;
    }
    if (!state.running) return;
    state.running = false;
    const active = state.turnStarted || state.waiting;
    const kind = REASON_KIND[state.lastReason] || 'finished';
    state.turnStarted = false;
    state.lastReason = null;
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
      case 'user/message':
        state.lastPrompt = summarizePrompt(event.data && event.data.message, cfg.summaryMaxChars);
        break;
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
        if (state.waiting && result && result.message && result.message.callId === state.waitingCallId) {
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
    if (wasRunning) emit('waiting', state, agent.session);
  }

  // Seed: existing running agents are treated as active so their finish notifies.
  try {
    const agents = ctx.agents && ctx.agents.list ? ctx.agents.list() : undefined;
    if (Array.isArray(agents)) {
      for (const agent of agents) {
        if (agent && tracked(agent.session) && agent.status === 'running') {
          const state = stateFor(agent.id);
          state.id = agent.id;
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

  ctx.inject(['webServer'], (scoped) => {
    const server = typeof scoped.get === 'function' ? scoped.get('webServer') : scoped.webServer;
    if (server === undefined || server === null) return;
    const handler = createHandler(() => cfg, persist, journal, file, (_ctx, current, payload) => toastSender(ctx, current, payload));
    scoped.effect(() => server.register({ kind: 'prefix', path: PROFILE, handler }), 'task-radar routes');
  });
}

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body too large'));
        try { req.destroy(); } catch { /* ignore */ }
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function createHandler(getCfg, persist, journal, file, toastSender = fireToast) {
  return async (req, res) => {
    let url;
    try {
      url = new URL(req.url || '/', 'http://task-radar.invalid');
    } catch {
      json(res, 400, { ok: false, reason: 'bad-url' });
      return;
    }
    const path = url.pathname;
    const method = (req.method || 'GET').toUpperCase();

    try {
      if (path === PROFILE + '/radar' && (method === 'GET' || method === 'HEAD')) {
        json(res, 200, { ok: true, version, journal: journal.slice(), config: getCfg() });
        return;
      }
      if (path === PROFILE + '/config' && method === 'POST') {
        const raw = await readBody(req, 256 * 1024);
        let incoming;
        try {
          incoming = JSON.parse(raw);
        } catch {
          json(res, 400, { ok: false, reason: 'bad-json' });
          return;
        }
        persist(incoming && incoming.config ? incoming.config : incoming);
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
  createHandler,
  DEFAULT_CONFIG,
};
