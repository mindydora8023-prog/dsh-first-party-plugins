/**
 * Generic HTTP webhook sender for dsh-plugin-task-radar.
 *
 * Bounded by an `.unref()`ed abort timeout, cancels/drains response bodies in
 * `finally` to avoid leaking sockets, and respects an optional lifecycle signal
 * so plugin unload aborts in-flight requests cleanly.
 *
 * ASCII only.
 */

export const WEBHOOK_TIMEOUT_MS = 8000;

/**
 * POST a JSON notification to a user-supplied URL.
 *
 * `fetchImpl` is injectable so tests never touch the network.
 */
export function createWebhookSender({ fetchImpl, timeoutMs = WEBHOOK_TIMEOUT_MS, signal } = {}) {
  const doFetch = typeof fetchImpl === 'function'
    ? fetchImpl
    : (typeof fetch === 'function' ? fetch : undefined);

  return function sendWebhook(ctx, cfg, payload) {
    if (signal && signal.aborted) return false;
    const warn = (message) => {
      if (ctx.logger && ctx.logger.warn) ctx.logger.warn(message);
    };
    const url = cfg && cfg.webhook ? cfg.webhook.url : '';
    if (typeof url !== 'string' || url === '') return false;
    if (doFetch === undefined) {
      warn('task-radar: webhook skipped (no fetch available)');
      return false;
    }

    const controller = new AbortController();
    const onLifecycleAbort = () => controller.abort();
    if (signal) {
      signal.addEventListener('abort', onLifecycleAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    const cleanup = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onLifecycleAbort);
    };

    try {
      Promise.resolve(doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: payload.title,
          body: payload.body,
          location: payload.location || '',
          kind: payload.kind,
          session: payload.session,
          at: payload.at,
        }),
        signal: controller.signal,
      }))
        .then(
          (response) => {
            if (response && typeof response.ok === 'boolean' && response.ok === false) {
              warn('task-radar: webhook responded ' + String(response.status));
            }
            if (response && response.body && typeof response.body.cancel === 'function') {
              return Promise.resolve(response.body.cancel()).catch(() => {});
            }
            return undefined;
          },
          (error) => {
            if (!signal || !signal.aborted) {
              warn('task-radar: webhook failed: ' + String(error));
            }
          },
        )
        .finally(cleanup);
      return true;
    } catch (error) {
      cleanup();
      warn('task-radar: webhook failed: ' + String(error));
      return false;
    }
  };
}

const defaultWebhookSender = createWebhookSender();
export function fireWebhook(ctx, cfg, payload) {
  return defaultWebhookSender(ctx, cfg, payload);
}
