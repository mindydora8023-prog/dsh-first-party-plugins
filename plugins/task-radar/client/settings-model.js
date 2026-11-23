/**
 * Settings form state machine for dsh-plugin-task-radar.
 *
 * Syncs `watcher.cfg` / `watcher.system` immediately on successful Save and
 * validates quiet-hour HH:MM strings before posting so malformed times produce
 * immediate user feedback instead of silently resetting on the host.
 *
 * ASCII only.
 */

export const CLOCK_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function validClock(value) {
  return typeof value === 'string' && CLOCK_RE.test(value.trim());
}

export function settingsInitialState() {
  return { config: null, loading: true, dirty: false, busy: '', status: '', reason: '' };
}

export function validSettings(config) {
  return Boolean(
    config
    && typeof config === 'object'
    && !Array.isArray(config)
    && ['events', 'toast', 'system', 'page', 'quiet'].every(
      (key) => config[key] && typeof config[key] === 'object' && !Array.isArray(config[key]),
    ),
  );
}

// One form model owns drafts and requests. Responses may normalize the
// submitted revision but must never replace edits made while it was saving.
export function createSettingsModel() {
  let state = settingsInitialState();
  let active = true;
  let revision = 0;
  let loading = false;
  const listeners = new Set();
  const requests = new Set();

  function update(patch) {
    if (!active) return;
    state = { ...state, ...patch };
    for (const listener of listeners) listener(state);
  }

  async function request(path, options = {}) {
    let cancelFn;
    try {
      return await fetchJsonWithTimeout(path, {
        strict: true,
        init: options,
        onRegister: (cancel) => {
          cancelFn = cancel;
          requests.add(cancel);
        },
      });
    } finally {
      if (cancelFn) requests.delete(cancelFn);
    }
  }

  async function load() {
    if (!active || loading || state.busy) return;
    loading = true;
    update({ loading: true, reason: '' });
    try {
      const payload = await request('/radar');
      if (!validSettings(payload.config)) throw new Error('invalid-response');
      syncWatcherConfig(payload.config, payload.configVersion);
      update({ config: payload.config, loading: false, dirty: false, status: '', reason: '' });
    } catch (error) {
      update({ loading: false, reason: String(error.message || error).slice(0, 160) });
    } finally {
      loading = false;
    }
  }

  async function action(kind) {
    if (!active || !state.config || state.busy || loading) return;
    if (kind === 'save') {
      const quiet = state.config.quiet;
      if (quiet && (!validClock(quiet.start) || !validClock(quiet.end))) {
        update({ status: 'quiet.invalid', reason: '' });
        return;
      }
    }
    const submittedRevision = revision;
    const body = kind === 'save' ? JSON.stringify({ config: state.config }) : undefined;
    update({ busy: kind, status: kind === 'save' ? 'btn.saving' : 'test.sending', reason: '' });
    try {
      const payload = await request(kind === 'save' ? '/config' : '/test', {
        method: 'POST',
        ...(body ? { headers: { 'content-type': 'application/json' }, body } : {}),
      });
      if (kind === 'save') {
        if (!validSettings(payload.config)) throw new Error('invalid-response');
        // Propagate saved config immediately so the poller and UI do not wait
        // up to an idle poll interval to see the new settings.
        syncWatcherConfig(payload.config, payload.configVersion);
        if (revision === submittedRevision) {
          update({ config: payload.config, dirty: false, status: 'btn.saved' });
        } else {
          update({ status: 'btn.savedEarlier' });
        }
      } else {
        update({ status: payload.submitted === true ? 'test.sent' : 'test.noToast' });
      }
    } catch (error) {
      update({
        status: kind + (error.certain ? '.error' : '.unknown'),
        reason: String(error.message || error).slice(0, 160),
      });
    } finally {
      update({ busy: '' });
    }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
    load,
    save: () => action('save'),
    test: () => action('test'),
    set(mutator) {
      if (!active || !state.config) return;
      const next = JSON.parse(JSON.stringify(state.config));
      mutator(next);
      revision += 1;
      update({ config: next, dirty: true, status: '', reason: '' });
    },
    refreshPermission() { update({}); },
    dispose() {
      active = false;
      for (const cancel of requests) cancel();
      requests.clear();
      listeners.clear();
    },
  };
}
