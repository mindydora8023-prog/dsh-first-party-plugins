/**
 * Browser half of dsh-plugin-next-say.
 *
 * Built by `node ../tools/build-client.mjs next-say` from `client/bundle.json`.
 * Do not edit `lib/client.js` by hand; edit the modular sources under `client/`
 * and `lib/`.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-next-say',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;

    /** Locale namespace owned by this plugin. */
    const NS = 'nextSay';

    /** API prefix served by the Host half. */
    const API = '/next-say';

    /*__LOCALES__*/

    const zh = LOCALES.zh;
    const en = LOCALES.en;

    /*__CONFIG__*/

    /*__MATCH__*/

    /*__GHOST__*/

    /*__HTTP__*/

    /*__HOOKS__*/

    /*__GHOST_PAINTER__*/

    /*__SETTINGS_PAGE__*/

    /* -------------------------------------------------------------- wiring */

    function apply(ctx) {
      const locale = ctx.locale;
      if (locale && typeof locale.register === 'function') {
        ctx.effect(() => locale.register(NS, { zh, en }), 'next-say dictionaries');
      }

      ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
        name: 'conversation.input.overlay',
        id: 'next-say',
        order: 5,
        locale: NS,
      }, SuggestionRow));

      ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
        name: 'conversation.composer.dock',
        id: 'next-say-manual',
        order: 20,
        locale: NS,
      }, ManualControl));

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'next-say',
        order: 37,
        locale: NS,
        label: () => ctx.locale.bind(NS)('settingsNav'),
      }, SettingsPage));
    }

    const moduleExports = {
      name: 'next-say',
      inject: ['slots', 'locale'],
      apply,
      __internals: {
        NS,
        API,
        zh,
        en,
        DEFAULT_SETTINGS,
        RANGES,
        isPaused,
        clampTo,
        inComposer,
        historyCompletion,
        historyRecallStep,
        normalizeForMatch,
        SuggestionRow,
        GhostPainter,
        ManualControl,
        manualControls,
        settingsStore,
        createHistoryCache,
        loadSettings,
        saveSettings,
        SettingsPage,
      },
    };
    return moduleExports;
  },
});
