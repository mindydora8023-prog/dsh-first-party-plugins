/**
 * Browser OS notification display and multi-tab receipt deduplication via
 * Web Locks + localStorage.
 *
 * ASCII only.
 */

export const RECEIPT_KEY = ['task-radar', 'notification', 'receipts', 'v1'].join('.');
export const RECEIPT_LIMIT = 512;
export const RECEIPT_GENERATIONS = 4;

export function showSystemNotification(kind, title, body, location, sessionId) {
  try {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return false;
    const text = location ? body + '\n' + location : body;
    const note = new Notification(title, {
      body: text,
      tag: 'task-radar-' + kind + '-' + (sessionId || 'nosession'),
      renotify: true,
      silent: false,
    });
    note.onclick = () => {
      try { window.focus(); } catch { /* ignore */ }
      openSessionById(sessionId);
      try { note.close(); } catch { /* ignore */ }
    };
    return true;
  } catch {
    return false;
  }
}

export function requestSystemPermission() {
  try {
    if (typeof Notification === 'undefined') return Promise.resolve('unsupported');
    if (Notification.permission !== 'default') return Promise.resolve(Notification.permission);
    return Promise.resolve(Notification.requestPermission()).catch(() => 'denied');
  } catch {
    return Promise.resolve('denied');
  }
}

export function readReceipts(storage) {
  const raw = storage.getItem(RECEIPT_KEY);
  if (!raw || raw.length > 65536) return [];
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .slice(0, RECEIPT_GENERATIONS)
    .filter((item) => item && typeof item.id === 'string' && item.id.length <= 128 && Array.isArray(item.sequences))
    .map((item) => ({
      id: item.id,
      sequences: item.sequences.slice(-RECEIPT_LIMIT).filter((n) => Number.isSafeInteger(n) && n > 0),
    }));
}

// A short origin-wide lock protects receipts for events actually shown.
// Never publish a shared high watermark: a newer tab can see sequence 102
// before an older tab receives 101. Bounded receipts may permit a duplicate
// after eviction; they never claim that an unseen event was delivered.
export async function deliverSystemEntry(entry, journalId, current) {
  const send = () => {
    if (!current()) return false;
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return true;
    return showSystemNotification(entry.kind, entry.title, entry.body, entry.location, entry.session);
  };
  let delivered = false;
  let storage;
  let locks;
  try {
    locks = window.navigator && window.navigator.locks;
    storage = window.localStorage;
  } catch {
    return send();
  }
  if (!journalId || !Number.isSafeInteger(entry.sequence) || !locks || typeof locks.request !== 'function' || !storage) {
    return send();
  }
  try {
    return await locks.request('task-radar.notification-receipts', { mode: 'exclusive', ifAvailable: true }, (lock) => {
      if (!current() || !lock) return false;
      const receipts = readReceipts(storage);
      let journal = receipts.find((item) => item.id === journalId);
      if (journal && journal.sequences.includes(entry.sequence)) return true;
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return true;
      delivered = showSystemNotification(entry.kind, entry.title, entry.body, entry.location, entry.session);
      if (!delivered) return false;
      journal = journal || { id: journalId, sequences: [] };
      journal.sequences.push(entry.sequence);
      journal.sequences = journal.sequences.slice(-RECEIPT_LIMIT);
      storage.setItem(
        RECEIPT_KEY,
        JSON.stringify([journal, ...receipts.filter((item) => item.id !== journalId)].slice(0, RECEIPT_GENERATIONS)),
      );
      return true;
    });
  } catch {
    // Storage or Web Locks can be disabled. Preserve single-page delivery;
    // a write failure after display must not send again in this same poll.
    return delivered || send();
  }
}
