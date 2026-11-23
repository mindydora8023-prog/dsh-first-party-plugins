/**
 * Agent/session lifecycle state machine, label resolution, cooldown, and quiet
 * hours dispatch for dsh-plugin-task-radar.
 *
 * Adapted from Pasumao/dsh-plugin-notify.
 * Copyright (c) 2026 Pasumao. MIT; see ../THIRD_PARTY_NOTICES.md and ../licenses/.
 *
 * ASCII only; Chinese notification copy is \uXXXX escaped.
 */

import { KIND_LABELS, inQuietHours } from './config.js';

export const JOURNAL_LIMIT = 24;
const MAX_STATES = 500;

/** turn/end reason kind -> normalized event kind. */
export const REASON_KIND = {
  completed: 'finished',
  aborted: 'aborted',
  error: 'error',
  interrupted: 'aborted',
  'max-tokens': 'error',
  blocked: 'aborted',
};

function truncate(text, max) {
  if (typeof text !== 'string') return '';
  return text.length <= max ? text : text.slice(0, max) + '\u2026';
}

function pathBasename(filePath) {
  if (typeof filePath !== 'string' || !filePath) return '';
  return String(filePath).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
}

export function resolveWorkspaceLabel(ctx, session) {
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

export function resolveSessionLabel(ctx, session) {
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

export function composeLocation(workspace, sessionLabel) {
  const parts = [];
  if (workspace) parts.push('\u5de5\u4f5c\u533a\u300c' + workspace + '\u300d');
  if (sessionLabel) parts.push('\u4f1a\u8bdd\u300c' + sessionLabel + '\u300d');
  return truncate(parts.join(' \u00b7 '), 96);
}

export function summarizePrompt(message, maxChars) {
  const blocks = message && message.content;
  if (!Array.isArray(blocks)) return '';
  for (const block of blocks) {
    if (block && block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
      return truncate(block.text.replace(/\s+/g, ' ').trim(), maxChars);
    }
  }
  return '';
}

export function extractQuestion(rawArguments) {
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

function isRoot(session) {
  const header = session && session.header;
  if (header && header.origin === 'subagent') return false;
  const depth = header && header.delegationDepth;
  return depth == null || depth === 0;
}

/**
 * Create the lifecycle tracker, event handlers, and bounded journal for one
 * plugin instance.
 */
export function createLifecycle({ ctx, getCfg, toastSender, webhookSender, nowOf }) {
  const journal = [];
  const states = new Map();
  let journalSequence = 0;

  function stateFor(id) {
    let state = states.get(id);
    if (!state) {
      state = {
        running: false,
        turnStarted: false,
        lastReason: null,
        lastPrompt: '',
        waiting: false,
        waitingCallId: null,
        waitingText: '',
        session: null,
        lastAt: {},
      };
      states.set(id, state);
      if (states.size > MAX_STATES) {
        for (const [key, value] of states) {
          if (key !== id && value.running !== true) {
            states.delete(key);
            break;
          }
        }
      }
    }
    return state;
  }

  function tracked(session) {
    return getCfg().rootsOnly ? isRoot(session) : true;
  }

  function pushJournal(entry) {
    journal.push({ ...entry, sequence: ++journalSequence });
    while (journal.length > JOURNAL_LIMIT) journal.shift();
  }

  function emit(kind, state, session) {
    const cfg = getCfg();
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
    if (cfg.webhook && cfg.webhook.enabled && cfg.webhook.url) {
      webhookSender(ctx, cfg, { title, body, location, kind, session: id, at: now });
    }
    if (ctx.logger && ctx.logger.debug) {
      ctx.logger.debug('task-radar: ' + kind + ' -> ' + title + (location ? ' (' + location + ')' : ''));
    }
  }

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
        if (getCfg().events.turnStart) emit('turnStart', state, agent.session);
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
        const message = event.data && (event.data.message || event.data);
        if (message && (!message.source || message.source.kind === 'user')) {
          state.lastPrompt = summarizePrompt(message, getCfg().summaryMaxChars);
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

  function seedRunningAgents() {
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
  }

  function activeNow() {
    for (const state of states.values()) {
      if (state.running === true || state.waiting === true) return true;
    }
    return false;
  }

  return {
    journal,
    states,
    onStatus,
    onSessionEvent,
    onDisposed,
    seedRunningAgents,
    activeNow,
  };
}
