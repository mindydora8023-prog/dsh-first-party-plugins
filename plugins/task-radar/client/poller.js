/**
 * Adaptive journal poller, in-page notice stack, and tab title indicator for
 * dsh-plugin-task-radar.
 *
 * Key invariants:
 * - Sends `journalId` and `configVersion` alongside `?since=N` so a host restart
 *   or config save never returns `{ unchanged: true }` and drops events/updates.
 * - Preserves `watcher.seeded = true` across `journalId` changes on an already
 *   running tab so post-restart events (seq 1, 2, ...) are never swallowed.
 * - Decouples in-page `page` cards from `deliverSystemEntry` failures/lock
 *   contention using `watcher.pageSeen` so cards appear immediately without
 *   duplicating on retry.
 *
 * ASCII only.
 */

export const POLL_BUSY_MS = 2500;
export const POLL_IDLE_MS = 12000;
export const NOTICE_LIMIT = 3;
const PAGE_SEEN_LIMIT = 256;

export const watcher = {
  timer: null,
  lastAt: 0,
  lastSequence: 0,
  journalId: null,
  configVersion: 0,
  seen: new Set(),
  pageSeen: new Set(),
  cfg: null,
  inFlight: false,
  request: null,
  active: true,
  system: false,
  seeded: false,
  onVisible: null,
  busy: false,
  delay: POLL_BUSY_MS,
  baseTitle: null,
  pendingTitle: 0,
};

export const notices = [];
export const noticeListeners = new Set();
let noticeSeq = 0;

export function syncWatcherConfig(cfg, configVersion) {
  if (!cfg || typeof cfg !== 'object') return;
  watcher.cfg = cfg;
  watcher.system = cfg.enabled !== false && Boolean(cfg.system && cfg.system.enabled === true);
  if (Number.isSafeInteger(configVersion) && configVersion > 0) {
    watcher.configVersion = configVersion;
  }
}

export function publishNotices() {
  const snapshot = notices.slice();
  for (const listener of noticeListeners) listener(snapshot);
}

export function dismissNotice(id) {
  const index = notices.findIndex((item) => item.id === id);
  if (index < 0) return;
  const [item] = notices.splice(index, 1);
  if (item.timer != null) window.clearTimeout(item.timer);
  publishNotices();
}

export function clearNotices() {
  for (const item of notices) {
    if (item.timer != null) window.clearTimeout(item.timer);
  }
  notices.splice(0, notices.length);
  publishNotices();
}

export function pageDurationMs() {
  const value = watcher.cfg && watcher.cfg.toast && Number(watcher.cfg.toast.durationMs);
  if (Number.isFinite(value) && value >= 3000 && value <= 30000) return value;
  return 8000;
}

export function pushNotice(entry) {
  const item = {
    id: ++noticeSeq,
    kind: entry.kind,
    title: entry.title || '',
    body: entry.body || '',
    location: entry.location || '',
    session: entry.session || '',
    timer: null,
  };
  notices.push(item);
  while (notices.length > NOTICE_LIMIT) {
    const dropped = notices.shift();
    if (dropped && dropped.timer != null) window.clearTimeout(dropped.timer);
  }
  item.timer = window.setTimeout(() => dismissNotice(item.id), pageDurationMs());
  publishNotices();
}

export function activateNotice(id) {
  const item = notices.find((entry) => entry.id === id);
  if (!item) return;
  openSessionById(item.session);
  dismissNotice(id);
}

export function noteHidden(kind) {
  try {
    if (!document || document.visibilityState !== 'hidden') return;
    if (watcher.baseTitle == null) watcher.baseTitle = String(document.title || '');
    watcher.pendingTitle += 1;
    const label = kind === 'waiting'
      ? translate('title.waiting')
      : translate('title.pending').replace('{count}', String(watcher.pendingTitle));
    document.title = '\uD83D\uDD14 ' + label + ' \u2014 ' + watcher.baseTitle;
  } catch { /* non-DOM host */ }
}

export function restoreTitle() {
  try {
    if (watcher.baseTitle != null && document) document.title = watcher.baseTitle;
  } catch { /* ignore */ }
  watcher.baseTitle = null;
  watcher.pendingTitle = 0;
}

/**
 * Reveal a session in the running app using the client `uiWorkspace` service.
 */
export function openSessionById(id) {
  if (!id) return;
  try {
    const ws = (appCtx && appCtx.uiWorkspace)
      || (appCtx && typeof appCtx.get === 'function' ? appCtx.get('uiWorkspace') : null);
    if (ws && typeof ws.openSession === 'function') {
      ws.openSession(id);
    }
  } catch { /* ignore */ }
}

function recordPageSeen(key) {
  watcher.pageSeen.add(key);
  if (watcher.pageSeen.size > PAGE_SEEN_LIMIT) {
    const first = watcher.pageSeen.values().next().value;
    if (first !== undefined) watcher.pageSeen.delete(first);
  }
}

export async function tick() {
  if (!watcher.active || watcher.inFlight) return;
  watcher.inFlight = true;
  const scope = createRequestScope(POLL_TIMEOUT_MS, 'task-radar poll cancelled');
  const request = { cancel: scope.cancel };
  watcher.request = request;
  const current = () => watcher.active && watcher.request === request && !scope.controller.signal.aborted;
  try {
    let query = '';
    if (watcher.seeded === true && watcher.lastSequence > 0) {
      const params = ['since=' + watcher.lastSequence];
      if (watcher.journalId) params.push('journalId=' + encodeURIComponent(watcher.journalId));
      if (watcher.configVersion > 0) params.push('configVersion=' + watcher.configVersion);
      query = '?' + params.join('&');
    }
    const payload = await fetchJsonWithTimeout('/radar' + query, { scope, strict: false });
    if (!watcher.active || watcher.request !== request || !payload || payload.ok !== true) return;

    if (payload.unchanged === true) {
      const nextId = typeof payload.journalId === 'string' ? payload.journalId : null;
      if (nextId !== watcher.journalId) {
        watcher.lastSequence = 0;
        watcher.lastAt = 0;
        watcher.seen.clear();
        watcher.pageSeen.clear();
        watcher.journalId = nextId;
        // Keep watcher.seeded = true on an already-seeded tab so post-restart
        // events (starting from sequence 1) are delivered instead of dropped.
      }
      if (Number.isSafeInteger(payload.configVersion) && payload.configVersion > 0) {
        watcher.configVersion = payload.configVersion;
      }
      watcher.busy = payload.active === true;
      return;
    }

    const cfg = payload.config || {};
    syncWatcherConfig(cfg, payload.configVersion);
    const journal = Array.isArray(payload.journal) ? payload.journal : [];
    const journalId = typeof payload.journalId === 'string' ? payload.journalId : null;
    const sequenced = journalId !== null;
    if (watcher.journalId !== journalId) {
      watcher.lastSequence = 0;
      watcher.lastAt = 0;
      watcher.seen.clear();
      watcher.pageSeen.clear();
      watcher.journalId = journalId;
    }
    const seed = watcher.seeded !== true;
    const boundary = watcher.lastAt;
    const seen = new Set(watcher.seen);
    for (const entry of journal) {
      if (!entry || !Number.isFinite(entry.at)) continue;
      const identity = sequenced ? null : JSON.stringify(entry);
      if (sequenced) {
        if (!Number.isSafeInteger(entry.sequence) || entry.sequence <= watcher.lastSequence) continue;
      } else if (entry.at < boundary || seen.has(identity)) continue;

      const pageOn = Boolean(cfg.page && cfg.page.enabled === true);
      const eventAllowed = !seed && cfg.enabled !== false && !(cfg.events && cfg.events[entry.kind] === false);
      if (eventAllowed && (watcher.system || pageOn)) {
        const pageKey = sequenced ? ('seq:' + entry.sequence) : ('raw:' + identity);
        let notedHidden = false;
        // Deliver the in-page card independently of Web Locks / system Notification
        // so a blocked or failing OS notification never suppresses the in-page card.
        if (pageOn && !watcher.pageSeen.has(pageKey)) {
          recordPageSeen(pageKey);
          pushNotice(entry);
          noteHidden(entry.kind);
          notedHidden = true;
        }
        if (watcher.system) {
          let consumed = false;
          try {
            consumed = await Promise.race([deliverSystemEntry(entry, journalId, current), scope.cancelled]);
          } catch {
            if (!current()) return;
            consumed = false;
          }
          if (!current()) return;
          if (!consumed) break;
          if (!notedHidden) noteHidden(entry.kind);
        }
      }
      if (sequenced) watcher.lastSequence = entry.sequence;
      else seen.add(identity);
      watcher.lastAt = Math.max(watcher.lastAt, entry.at);
    }
    watcher.seen = new Set(
      journal
        .filter((entry) => entry && entry.at === watcher.lastAt)
        .map((entry) => JSON.stringify(entry))
        .filter((identity) => seen.has(identity)),
    );
    watcher.seeded = true;
    watcher.busy = payload.active === true;
  } catch { /* offline, deadline or disposal; a later poll can recover */ } finally {
    scope.dispose();
    if (watcher.request === request) {
      watcher.request = null;
      watcher.inFlight = false;
      if (watcher.active && watcher.timer !== null) {
        armWatcher(watcher.busy ? POLL_BUSY_MS : POLL_IDLE_MS);
      }
    }
  }
}

export function armWatcher(delay) {
  const next = delay === POLL_IDLE_MS ? POLL_IDLE_MS : POLL_BUSY_MS;
  if (watcher.timer !== null && watcher.delay === next) return;
  if (watcher.timer !== null) window.clearInterval(watcher.timer);
  watcher.delay = next;
  watcher.timer = window.setInterval(() => { void tick(); }, next);
}

export function disarmWatcher() {
  if (watcher.timer === null) return;
  window.clearInterval(watcher.timer);
  watcher.timer = null;
}

// Background pages can show Web Notifications. Keep polling when hidden;
// browsers may throttle timers, so visibility restoration also polls now.
export function startWatcher() {
  const sync = () => {
    try {
      if (document.visibilityState !== 'hidden') {
        restoreTitle();
        void tick();
      }
    } catch { /* non-DOM host */ }
  };
  watcher.onVisible = sync;
  try { document.addEventListener('visibilitychange', sync); } catch { /* non-DOM host */ }
  void tick();
  armWatcher(POLL_BUSY_MS);
}
