window.__ModuleLoader__.load({
  id: 'dsh-plugin-sauce-theme',
  factory(require) {
    var React = require('react');
    var h = React.createElement;

    var ON_KEY = 'sauce-theme:on';
    var LEGACY_MODE_KEY = 'sauce-theme:mode';
    var FONT_KEY = 'sauce-theme:font';
    var PREV_KEY = 'sauce-theme:prev-builtin';

    var MONO =
      '"Fira Code", "JetBrains Mono", "Cascadia Code", "Sarasa Mono SC", "Microsoft YaHei", "PingFang SC", ui-monospace, monospace';

    // Single light colorway (kept from the current look, borrowed from
    // Catppuccin Latte): mauve headings, blue links, peach secondary.
    var ACCENT = { primary: '#8839ef', accent: '#fe640b', func: '#1e66f5' };
    var SYN = {
      keyword: '#8839ef', function: '#1e66f5', string: '#40a02b', constant: '#fe640b',
      comment: '#8c8fa1', parameter: '#df8e1d', punctuation: '#7c7f93', link: '#04a5e5'
    };

    function hexToRgba(hex, a) {
      var s = hex.replace('#', '');
      if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
      var r = parseInt(s.substring(0, 2), 16);
      var g = parseInt(s.substring(2, 4), 16);
      var b = parseInt(s.substring(4, 6), 16);
      return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + a + ')';
    }

    // Light-scheme overrides only. Structural surfaces stay the stock DSH light
    // theme; we add accents, restrained prose colouring and syntax colours.
    function accentCss() {
      var pre = 'body:not([data-ds-dark-theme]) ';
      var S = '[class*="_markdown_"]';
      var qbg = hexToRgba(ACCENT.primary, 0.055);
      var syn = 'body:not([data-ds-dark-theme]) {\n' + [
        '  --shiki-token-keyword: ' + SYN.keyword + ' !important;',
        '  --shiki-token-function: ' + SYN.function + ' !important;',
        '  --shiki-token-string: ' + SYN.string + ' !important;',
        '  --shiki-token-string-expression: ' + SYN.string + ' !important;',
        '  --shiki-token-constant: ' + SYN.constant + ' !important;',
        '  --shiki-token-comment: ' + SYN.comment + ' !important;',
        '  --shiki-token-parameter: ' + SYN.parameter + ' !important;',
        '  --shiki-token-punctuation: ' + SYN.punctuation + ' !important;',
        '  --shiki-token-link: ' + SYN.link + ' !important;'
      ].join('\n') + '\n}';
      var prose = [
        pre + S + ' h1{color:' + ACCENT.primary + ';font-weight:700;border-bottom:1px solid var(--dsw-alias-border-l2);padding-bottom:.35em}',
        pre + S + ' h2{color:' + ACCENT.primary + ';font-weight:700}',
        pre + S + ' h3{color:' + ACCENT.accent + ';font-weight:600}',
        pre + S + ' h4,' + pre + S + ' h5,' + pre + S + ' h6{color:var(--dsw-alias-label-tertiary);font-weight:600}',
        pre + S + ' :is(strong,b){font-weight:650}',
        pre + S + ' a{color:' + ACCENT.func + '}',
        pre + S + ' a:hover{color:' + ACCENT.primary + '}',
        pre + S + ' li::marker{color:' + ACCENT.accent + '}',
        pre + S + ' blockquote{border-left:3px solid ' + ACCENT.primary + ';background:' + qbg + ';border-radius:0 6px 6px 0;padding:8px 14px}',
        pre + S + ' th{color:' + ACCENT.primary + '}',
        pre + S + ' hr{background:var(--dsw-alias-border-l2)}'
      ];
      return syn + '\n' + prose.join('\n');
    }

    // Align the composer context-occupancy meter (13px) with the session-meter
    // pill (12px) so the shared status row reads as one consistent line.
    var METER_FIX = [
      '.A6Bq1a_trigger{font-size:12px !important;line-height:20px !important;}',
      'button[aria-haspopup="dialog"][aria-label*="%"]{font-size:12px !important;line-height:20px !important;}'
    ].join('\n');

    function buildContentCss(fontScope) {
      var rules = [];
      if (fontScope === 'global') {
        rules.push('body, body *{font-family:' + MONO + ' !important;}');
      } else {
        rules.push('[class*="_markdown_"]{font-family:' + MONO + ' !important;}');
        rules.push('[class*="_markdown_"] :is(p,li,h1,h2,h3,h4,h5,h6,td,th,blockquote,dt,dd){font-family:' + MONO + ' !important;}');
        rules.push('[class*="_userStack_"]{font-family:' + MONO + ' !important;}');
      }
      rules.push(accentCss());
      rules.push(METER_FIX);
      rules.push('::selection{background:rgba(136,57,239,0.16);}');
      return rules.join('\n');
    }

    var ROW_CSS = [
      '.sauce-theme-row { border-bottom: 0.5px solid var(--dsw-alias-border-l2); display: flex; align-items: center; gap: 16px; padding: 16px 0; }',
      '.sauce-theme-row-text { display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 0; }',
      '.sauce-theme-row-title { color: var(--dsw-alias-label-primary); font-size: 14px; line-height: 22px; }',
      '.sauce-theme-row-desc { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }',
      '.sauce-theme-seg { display: inline-flex; border: 0.5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md); overflow: hidden; flex: none; }',
      '.sauce-theme-seg button { font: inherit; font-size: 13px; line-height: 20px; padding: 6px 12px; cursor: pointer; border: 0; background: transparent; color: var(--dsw-alias-label-secondary); }',
      '.sauce-theme-seg button + button { border-left: 0.5px solid var(--dsw-alias-border-l4); }',
      '.sauce-theme-seg button:hover { background: var(--dsw-alias-interactive-bg-hover); }',
      '.sauce-theme-seg button[data-on="1"] { background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-label-primary-foreground); }'
    ].join('\n');

    return {
      inject: ['slots', 'theme'],
      apply(ctx) {
        var state = { on: true, fontScope: 'content' };

        try {
          var on = window.localStorage.getItem(ON_KEY);
          if (on === 'on' || on === 'off') state.on = on === 'on';
          else {
            var legacy = window.localStorage.getItem(LEGACY_MODE_KEY);
            state.on = legacy === 'off' ? false : true;
          }
          var sf = window.localStorage.getItem(FONT_KEY);
          if (sf === 'global' || sf === 'content') state.fontScope = sf;
        } catch (e) {}

        // Clear any accent-token layer left by an earlier version so the settings
        // page and other UI chrome return to the default DSH accent (no purple).
        try { ctx.theme.overrideTokens('sauce-accent', {}); } catch (e) {}

        ctx.effect(function () {
          var tag = document.createElement('style');
          tag.setAttribute('data-sauce-theme', 'row');
          tag.textContent = ROW_CSS;
          document.head.append(tag);
          return function () { tag.remove(); };
        }, 'sauce-theme: row styles');

        var contentTag = null;

        function rememberPrevBuiltin() {
          try {
            var cur = ctx.theme.getTheme();
            var pref = cur && cur.preference;
            if (pref === 'light' || pref === 'dark' || pref === 'system') window.localStorage.setItem(PREV_KEY, pref);
          } catch (e) {}
        }

        function applyOn() {
          // No token overrides: the settings page / UI chrome keeps the stock
          // DSH accent. Only the conversation prose + syntax are themed.
          if (!contentTag) {
            contentTag = document.createElement('style');
            contentTag.setAttribute('data-sauce-theme', 'content');
            document.head.append(contentTag);
          }
          contentTag.textContent = buildContentCss(state.fontScope);
          ctx.theme.setTheme('light');
        }

        function teardown() {
          if (contentTag) { contentTag.remove(); contentTag = null; }
          var prev = 'system';
          try { prev = window.localStorage.getItem(PREV_KEY) || 'system'; } catch (e) {}
          if (prev !== 'light' && prev !== 'dark') prev = 'system';
          ctx.theme.setTheme(prev);
        }

        function persist(key, value) {
          try { window.localStorage.setItem(key, value); } catch (e) {}
        }
        function chooseOn(next) {
          if (next === state.on) return;
          if (next) {
            rememberPrevBuiltin();
            state.on = true;
            persist(ON_KEY, 'on');
            applyOn();
          } else {
            state.on = false;
            persist(ON_KEY, 'off');
            teardown();
          }
        }
        function chooseFontScope(next) {
          state.fontScope = next === 'global' ? 'global' : 'content';
          persist(FONT_KEY, state.fontScope);
          if (state.on) {
            if (contentTag) contentTag.textContent = buildContentCss(state.fontScope);
          }
        }

        function markSeg(el, value) {
          var kids = el.parentNode.children;
          for (var i = 0; i < kids.length; i += 1) {
            kids[i].setAttribute('data-on', kids[i].getAttribute('data-val') === value ? '1' : '0');
          }
        }

        function ModeRow() {
          function opt(value, label) {
            return h('button', {
              type: 'button', 'data-val': value, 'data-on': (state.on ? 'on' : 'off') === value ? '1' : '0',
              onClick: function (ev) { chooseOn(value === 'on'); markSeg(ev.currentTarget, value); }
            }, label);
          }
          return h('div', { className: 'sauce-theme-row' },
            h('div', { className: 'sauce-theme-row-text' },
              h('div', { className: 'sauce-theme-row-title' }, '\u4ee3\u7801\u9171\u4e3b\u9898'),
              h('div', { className: 'sauce-theme-row-desc' }, '\u6d45\u8272\u914d\u8272 + \u7b49\u5bbd\u6b63\u6587\u3002\u5173\u95ed\u6062\u590d\u5185\u7f6e\u5916\u89c2\u3002')
            ),
            h('div', { className: 'sauce-theme-seg' }, opt('on', '\u5f00'), opt('off', '\u5173'))
          );
        }

        function FontRow() {
          function opt(value, label) {
            return h('button', {
              type: 'button', 'data-val': value, 'data-on': state.fontScope === value ? '1' : '0',
              onClick: function (ev) { chooseFontScope(value); markSeg(ev.currentTarget, value); }
            }, label);
          }
          return h('div', { className: 'sauce-theme-row' },
            h('div', { className: 'sauce-theme-row-text' },
              h('div', { className: 'sauce-theme-row-title' }, '\u4ee3\u7801\u9171 \u00b7 \u5b57\u4f53\u8303\u56f4'),
              h('div', { className: 'sauce-theme-row-desc' }, '\u6b63\u6587 = \u53ea\u5bf9\u8bdd\u5185\u5bb9\u7b49\u5bbd\uff1b\u5168\u5c40 = \u6574\u4e2a\u754c\u9762\u7b49\u5bbd\u3002')
            ),
            h('div', { className: 'sauce-theme-seg' }, opt('content', '\u6b63\u6587'), opt('global', '\u5168\u5c40'))
          );
        }

        ctx.slots.inject('settings.general.item', function () {
          return ctx.slots.register({ name: 'settings.general.item', id: 'sauce-theme', order: 13, label: '\u4ee3\u7801\u9171\u4e3b\u9898' }, ModeRow);
        });
        ctx.slots.inject('settings.general.item', function () {
          return ctx.slots.register({ name: 'settings.general.item', id: 'sauce-font', order: 14, label: '\u4ee3\u7801\u9171 \u00b7 \u5b57\u4f53\u8303\u56f4' }, FontRow);
        });

        if (state.on) {
          var hadPrev = false;
          try { hadPrev = !!window.localStorage.getItem(PREV_KEY); } catch (e) {}
          if (!hadPrev) rememberPrevBuiltin();
          applyOn();
        }
      }
    };
  }
});
