/**
 * Unified transport fetch and timeout/abort race helper for task-radar client.
 *
 * Uses `window.__DSH_TRANSPORT__.fetch` when available, falling back to `fetch`,
 * and guards inner promises against UnhandledPromiseRejection when a deadline or
 * disposal cancels an in-flight call.
 *
 * ASCII only.
 */

export const POLL_TIMEOUT_MS = 10000;

export function hostFetch(input, init) {
  const carrier = window.__DSH_TRANSPORT__;
  return carrier && typeof carrier.fetch === 'function'
    ? carrier.fetch(input, init)
    : fetch(input, init);
}

/**
 * Create a cancellable deadline scope backed by window.setTimeout so callers
 * (both poller ticks and settings requests) share one consistent timeout model.
 */
export function createRequestScope(timeoutMs = POLL_TIMEOUT_MS, cancelMessage = 'request-timeout-or-cancelled') {
  const controller = new AbortController();
  let deadline;
  let cancel;
  const cancelled = new Promise((_, reject) => {
    cancel = () => {
      controller.abort();
      reject(new Error(cancelMessage));
    };
    deadline = window.setTimeout(cancel, timeoutMs);
  });
  // Keep rejected cancellations observed if a caller finishes before racing.
  cancelled.catch(() => {});
  return {
    controller,
    cancel,
    cancelled,
    dispose() {
      window.clearTimeout(deadline);
    },
  };
}

/**
 * Fetch JSON from `API + path` with deadline/cancellation safety.
 *
 * When `options.scope` is supplied, the caller owns disposing that scope;
 * otherwise a fresh scope is created and cleaned up in `finally`.
 */
export async function fetchJsonWithTimeout(path, options = {}) {
  const ownScope = !options.scope;
  const scope = options.scope || createRequestScope(
    options.timeoutMs ?? POLL_TIMEOUT_MS,
    options.cancelMessage || 'request-timeout-or-cancelled',
  );
  if (typeof options.onRegister === 'function') {
    options.onRegister(scope.cancel, scope.controller);
  }
  const work = (async () => {
    const response = await hostFetch(API + path, {
      credentials: 'same-origin',
      ...(options.init || {}),
      signal: scope.controller.signal,
    });
    if (options.strict !== true) {
      return response.ok ? await response.json() : null;
    }
    const payload = await response.json();
    if (!response.ok || !payload || payload.ok !== true) {
      throw Object.assign(
        new Error((payload && payload.reason) || 'http-' + response.status),
        {
          certain: (response.status >= 400 && response.status < 500)
            || Boolean(payload && payload.reason === 'plugin-unloaded'),
        },
      );
    }
    return payload;
  })();
  // Prevent UnhandledPromiseRejection if deadline/cancel wins the race.
  work.catch(() => {});
  try {
    return await Promise.race([work, scope.cancelled]);
  } finally {
    if (ownScope) scope.dispose();
  }
}
