import { Readable } from 'node:stream';

/** Adapt the plugin's async Node handler to connection.fetch.register. */
export function adaptHandler(handler, { cleanupTimeoutMs = 1000 } = {}) {
  if (typeof handler !== 'function') throw new TypeError('handler must be a function');
  if (!Number.isInteger(cleanupTimeoutMs) || cleanupTimeoutMs < 0 || cleanupTimeoutMs > 1000) {
    throw new RangeError('cleanupTimeoutMs must be an integer from 0 to 1000');
  }
  return async function fetchHandler(request) {
    const req = request.body ? Readable.fromWeb(request.body) : Readable.from([]);
    const url = new URL(request.url);
    req.method = request.method;
    req.url = url.pathname + url.search;
    req.headers = Object.fromEntries(request.headers);
    req.aborted = false;

    // destroy() emits error asynchronously, before close. Keep this observer
    // even when readBody removes its own observer upon seeing req.destroyed.
    const onError = () => {};
    req.on('error', onError);
    let closed = req.closed;
    const close = new Promise((resolve) => {
      if (closed) resolve();
      else req.once('close', () => { closed = true; resolve(); });
    });
    let status = 200;
    let headers = new Headers();
    let body;
    const res = {
      destroyed: false,
      writableEnded: false,
      writeHead(code, messageOrHeaders, extraHeaders) {
        status = code;
        const values = typeof messageOrHeaders === 'string' ? extraHeaders : messageOrHeaders;
        headers = new Headers();
        if (Array.isArray(values)) {
          for (let i = 0; i < values.length; i += 2) headers.append(values[i], String(values[i + 1]));
        } else if (values) {
          for (const [name, value] of Object.entries(values)) {
            if (value === undefined) continue;
            for (const item of Array.isArray(value) ? value : [value]) headers.append(name, String(item));
          }
        }
        return this;
      },
      end(chunk, encoding) {
        if (this.writableEnded) return this;
        if (chunk !== undefined && chunk !== null) {
          body = typeof chunk === 'string' ? Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8') : Buffer.from(chunk);
        }
        this.writableEnded = true;
        return this;
      },
    };
    let cancel;
    const cancelled = new Promise((resolve) => { cancel = resolve; });
    let reason;
    const onAbort = () => {
      reason = request.signal.reason === undefined
        ? new DOMException('The operation was aborted', 'AbortError') : request.signal.reason;
      req.aborted = true;
      req.destroy(reason instanceof Error ? reason : undefined);
      cancel();
    };
    request.signal.addEventListener('abort', onAbort, { once: true });
    try {
      if (request.signal.aborted) onAbort();
      else {
        // The race also observes a handler that rejects after cancellation.
        await Promise.race([Promise.resolve().then(() => {
          if (!req.aborted) return handler(req, res);
        }), cancelled]);
      }
      if (!res.writableEnded) {
        if (req.aborted) throw reason;
        throw new Error('Node handler completed without ending the response');
      }
      const empty = request.method === 'HEAD' || status === 204 || status === 205 || status === 304;
      return new Response(empty ? null : body ?? null, { status, headers });
    } finally {
      request.signal.removeEventListener('abort', onAbort);
      if (!req.destroyed) req.destroy();
      // A Web cancel() may never settle, so destroy() need not emit close.
      // Bound the wait, then retain only the guard and terminal cleanup hook.
      let timer;
      try {
        if (!closed) {
          await Promise.race([close, new Promise((resolve) => {
            timer = setTimeout(resolve, cleanupTimeoutMs);
          })]);
        }
      } finally {
        clearTimeout(timer);
        req.removeAllListeners();
        if (!closed) {
          req.on('error', onError);
          req.once('close', () => req.removeAllListeners());
        }
      }
    }
  };
}
