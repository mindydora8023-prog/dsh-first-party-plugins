/**
 * Host half of dsh-plugin-session-meter.
 *
 * Thin Cordis entry point composing `lib/catalog-store.js` and `lib/routes.js`.
 * Even when `SESSION_METER_OFFLINE=1` is set, the plugin still loads any disk
 * snapshot and registers `/session-meter/prices` so offline sessions serve
 * cached prices cleanly instead of hitting 404 loops.
 *
 * Pure ASCII only (workspace convention).
 */
import { createCatalogStore, numberFromEnv, statusFilePath } from './catalog-store.js';
import {
  BALANCE_PATH,
  REPORT_PATH,
  ROUTE,
  createBalanceHandler,
  createBalanceReader,
  createPriceHandler,
  handleSpendReport,
} from './routes.js';

export { statusFilePath, createBalanceReader };

export function apply(ctx) {
  const offline = process.env.SESSION_METER_OFFLINE === '1';
  const store = createCatalogStore(ctx, { offline });

  if (!offline) {
    ctx.effect(() => {
      const timer = setInterval(() => {
        if (store.isCatalogWanted() && store.stale()) void store.refresh();
      }, 60 * 60 * 1000);
      if (typeof timer.unref === 'function') timer.unref();
      return () => clearInterval(timer);
    }, 'session-meter price refresh');
  }

  const priceHandler = createPriceHandler(store);
  const readBalance = createBalanceReader({
    keyProvider: () => process.env.SESSION_METER_DEEPSEEK_KEY ?? process.env.DEEPSEEK_API_KEY ?? '',
    timeoutMs: numberFromEnv('SESSION_METER_BALANCE_TIMEOUT_MS', 8000),
  });
  const balanceHandler = createBalanceHandler(readBalance);

  const attachRoutes = (server) => {
    // Register prices last so tests capturing the last registered
    // route still observe `/session-meter/prices`.
    ctx.effect(
      () => server.register({ kind: 'exact', path: BALANCE_PATH, handler: balanceHandler }),
      'session-meter balance route',
    );
    ctx.effect(
      () => server.register({ kind: 'exact', path: REPORT_PATH, handler: handleSpendReport }),
      'session-meter report route',
    );
    ctx.effect(() => {
      const dispose = server.register({ kind: 'exact', path: ROUTE, handler: priceHandler });
      store.status.route_registered = true;
      store.writeStatus();
      return dispose;
    }, 'session-meter price route');
  };

  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (childCtx) => {
      store.status.web_server = true;
      const server = typeof childCtx.get === 'function' ? childCtx.get('webServer') : childCtx.webServer;
      if (server !== undefined && server !== null) attachRoutes(server);
      store.writeStatus();
    });
  } else {
    const server = typeof ctx.get === 'function' ? ctx.get('webServer') : ctx.webServer;
    store.status.web_server = server !== undefined && server !== null;
    if (store.status.web_server) attachRoutes(server);
    store.writeStatus();
  }
}
