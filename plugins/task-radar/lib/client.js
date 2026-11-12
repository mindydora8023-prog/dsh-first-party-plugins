/**
 * Browser half of dsh-plugin-task-radar.
 *
 * One job: poll GET /task-radar/radar for the host-side journal and, for every
 * NEW entry, fire a browser OS-level notification (Windows Action Center / macOS
 * Notification Center / GNOME) via `new Notification(...)`. That is the channel
 * that reaches the user while the window is minimised or another app is in
 * front. The host half independently raises the native Windows toast, so even a
 * browser with notifications blocked still gets the system toast.
 *
 * It also registers the Settings page (settings.section): which events notify,
 * the two channels (Windows toast / browser system notification) with a live
 * permission badge, and the advanced knobs (cooldown, summary length, prefix).
 *
 * ASCII only by workspace convention; all Chinese copy is \u escaped.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-task-radar',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;

    const NS = 'taskRadar';
    const API = '/task-radar';

    /* ------------------------------------------------ locale dictionaries */
    const en = {
      'nav.title': 'Task radar',
      'nav.hint': 'System notifications when a task starts or finishes',
      'section.events': 'Events',
      'section.channels': 'Notification channels',
      'section.advanced': 'Advanced',
      'events.turnStart': 'Turn started',
      'events.finished': 'Turn finished',
      'events.aborted': 'Turn aborted',
      'events.error': 'Turn error',
      'events.waiting': 'Waiting for your choice',
      'events.hint': 'Only the checked events raise a notification.',
      'opt.enabled': 'Enable reminders',
      'opt.enabledHint': 'Master switch for every channel below.',
      'opt.rootsOnly': 'Root sessions only',
      'opt.rootsOnlyHint': 'Skip sub-agents so they do not flood you.',
      'opt.cooldown': 'Minimum gap (seconds)',
      'opt.summary': 'Task summary length (chars)',
      'opt.titlePrefix': 'Title prefix',
      'toast.name': 'Windows system toast',
      'toast.desc': 'Native Action Center toast from the background host. Works even when this window is closed.',
      'toast.persistent': 'Keep on screen until dismissed',
      'toast.iconPath': 'Custom icon PNG (blank = bundled)',
      'sys.name': 'Browser system notification',
      'sys.desc': 'Web Notification from this page. Shows over other apps while the window is minimised.',
      'sys.permission': 'Permission',
      'sys.granted': 'granted',
      'sys.denied': 'denied',
      'sys.deniedHint': 'Blocked. Re-allow notifications for this site in the browser settings.',
      'sys.default': 'not requested yet',
      'sys.request': 'Allow notifications',
      'sys.unsupported': 'not supported here',
      'badge.on': 'ON',
      'badge.off': 'OFF',
      'btn.save': 'Save',
      'btn.test': 'Send a test',
      'btn.saved': 'Saved',
      'btn.saving': 'Saving...',
      'test.sent': 'Windows test request submitted. Check your system notifications.',
      'test.noToast': 'No Windows toast was submitted. This test does not send a browser notification.',
      'load.error': 'Task radar: host API unreachable. Reopen this page.',
      'kind.turnStart': 'Turn started',
      'kind.finished': 'Turn finished',
      'kind.aborted': 'Turn aborted',
      'kind.error': 'Turn error',
      'kind.waiting': 'Waiting for you',
    };
    const zh = {
      'nav.title': '\u4efb\u52a1\u96f7\u8fbe',
      'nav.hint': '\u4efb\u52a1\u5f00\u59cb\u6216\u7ed3\u675f\u65f6\u53d1\u7cfb\u7edf\u901a\u77e5',
      'section.events': '\u4e8b\u4ef6',
      'section.channels': '\u901a\u77e5\u901a\u9053',
      'section.advanced': '\u9ad8\u7ea7',
      'events.turnStart': '\u5f00\u59cb\u8fd0\u884c',
      'events.finished': '\u5df2\u5b8c\u6210',
      'events.aborted': '\u5df2\u4e2d\u6b62',
      'events.error': '\u51fa\u9519',
      'events.waiting': '\u7b49\u5f85\u4f60\u9009\u62e9',
      'events.hint': '\u53ea\u6709\u52fe\u9009\u7684\u4e8b\u4ef6\u624d\u4f1a\u53d1\u901a\u77e5\u3002',
      'opt.enabled': '\u542f\u7528\u63d0\u9192',
      'opt.enabledHint': '\u4e0b\u65b9\u5168\u90e8\u901a\u9053\u7684\u603b\u5f00\u5173\u3002',
      'opt.rootsOnly': '\u4ec5\u6839\u4f1a\u8bdd',
      'opt.rootsOnlyHint': '\u4e0d\u901a\u77e5\u5b50\u4ee3\u7406\uff0c\u907f\u514d\u5237\u5c4f\u3002',
      'opt.cooldown': '\u6700\u5c0f\u95f4\u9694\uff08\u79d2\uff09',
      'opt.summary': '\u4efb\u52a1\u6458\u8981\u957f\u5ea6\uff08\u5b57\u7b26\uff09',
      'opt.titlePrefix': '\u6807\u9898\u524d\u7f00',
      'toast.name': 'Windows \u7cfb\u7edf Toast',
      'toast.desc': '\u7531\u540e\u53f0\u5bbf\u4e3b\u53d1\u51fa\u7684\u539f\u751f\u64cd\u4f5c\u4e2d\u5fc3 Toast\uff0c\u5373\u4f7f\u672c\u9875\u9762\u5173\u95ed\u4e5f\u80fd\u5f39\u3002',
      'toast.persistent': '\u5e38\u9a7b\uff0c\u76f4\u5230\u624b\u52a8\u5173\u95ed',
      'toast.iconPath': '\u81ea\u5b9a\u4e49\u56fe\u6807 PNG\uff08\u7559\u7a7a\u7528\u5185\u7f6e\uff09',
      'sys.name': '\u6d4f\u89c8\u5668\u7cfb\u7edf\u901a\u77e5',
      'sys.desc': '\u7531\u672c\u9875\u9762\u53d1\u51fa\u7684 Web \u901a\u77e5\uff0c\u7a97\u53e3\u6700\u5c0f\u5316\u65f6\u4e5f\u80fd\u5728\u5176\u4ed6\u5e94\u7528\u4e0a\u65b9\u5f39\u51fa\u3002',
      'sys.permission': '\u6388\u6743\u72b6\u6001',
      'sys.granted': '\u5df2\u6388\u6743',
      'sys.denied': '\u5df2\u62d2\u7edd',
      'sys.deniedHint': '\u88ab\u963b\u6b62\u3002\u8bf7\u5728\u6d4f\u89c8\u5668\u7ad9\u70b9\u8bbe\u7f6e\u91cc\u91cd\u65b0\u5141\u8bb8\u901a\u77e5\u3002',
      'sys.default': '\u5c1a\u672a\u8bf7\u6c42',
      'sys.request': '\u5141\u8bb8\u901a\u77e5',
      'sys.unsupported': '\u5f53\u524d\u73af\u5883\u4e0d\u652f\u6301',
      'badge.on': '\u5df2\u5f00',
      'badge.off': '\u5df2\u5173',
      'btn.save': '\u4fdd\u5b58',
      'btn.test': '\u53d1\u9001\u6d4b\u8bd5',
      'btn.saved': '\u5df2\u4fdd\u5b58',
      'btn.saving': '\u4fdd\u5b58\u4e2d',
      'test.sent': 'Windows \u6d4b\u8bd5\u8bf7\u6c42\u5df2\u63d0\u4ea4\uff0c\u8bf7\u5728\u7cfb\u7edf\u901a\u77e5\u4e2d\u6838\u5bf9\u3002',
      'test.noToast': '\u672a\u63d0\u4ea4 Windows Toast\u3002\u6b64\u6d4b\u8bd5\u4e0d\u53d1\u9001\u6d4f\u89c8\u5668\u901a\u77e5\u3002',
      'load.error': '\u4efb\u52a1\u96f7\u8fbe\uff1a\u5bbf\u4e3b API \u4e0d\u53ef\u8fbe\uff0c\u8bf7\u91cd\u65b0\u6253\u5f00\u9875\u9762\u3002',
      'kind.turnStart': '\u5f00\u59cb\u8fd0\u884c',
      'kind.finished': '\u5df2\u5b8c\u6210',
      'kind.aborted': '\u5df2\u4e2d\u6b62',
      'kind.error': '\u51fa\u9519',
      'kind.waiting': '\u7b49\u5f85\u4f60\u9009\u62e9',
    };

    function textKey(t, key) {
      try {
        const value = t(key);
        if (typeof value === 'string' && value !== '') return value;
      } catch { /* fall through */ }
      return zh[key] || key;
    }

    /* --------------------------------------------------- theme shortcuts */
    const C = {
      text: 'var(--dsw-alias-label-primary, #e6edf3)',
      muted: 'var(--dsw-alias-label-secondary, #9aa4b2)',
      faint: 'var(--dsw-alias-label-tertiary, #6b7280)',
      border: 'var(--dsw-alias-border-l2, #30363d)',
      card: 'var(--dsw-alias-bg-layer-1, rgba(255,255,255,0.02))',
      cardBorder: 'var(--dsw-alias-border-l1, rgba(255,255,255,0.08))',
      accent: 'var(--dsw-alias-state-success-primary, #3fae6b)',
      accentSoft: 'rgba(63,174,107,0.14)',
      warn: 'var(--dsw-alias-state-warn-primary, #e0a33a)',
      danger: 'var(--dsw-alias-state-error-primary, #ef4444)',
      inputBg: 'var(--dsw-alias-bg-overlay, rgba(0,0,0,0.25))',
    };

    /* ------------------------------------------------------------ watcher */
    const watcher = { timer: null, lastAt: 0, cfg: null, inFlight: false, system: true };
    let appCtx = null;

    /**
     * Reveal a session in the running app. Uses the client `uiWorkspace` service
     * (the same one the sidebar uses: openSession(sessionId) -> replaceMain). The
     * web app has no URL router, so this in-app call is the only way to "jump to
     * the session" from a notification click.
     */
    function openSessionById(id) {
      if (!id) return;
      try {
        const ws = (appCtx && appCtx.uiWorkspace) || (appCtx && typeof appCtx.get === 'function' ? appCtx.get('uiWorkspace') : null);
        if (ws && typeof ws.openSession === 'function') { ws.openSession(id); return; }
      } catch { /* ignore */ }
    }

    function showSystemNotification(kind, title, body, location, sessionId) {
      try {
        if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
        const text = location ? body + '\n' + location : body;
        const note = new Notification(title, { body: text, tag: 'task-radar-' + kind, renotify: true, silent: false });
        note.onclick = () => {
          try { window.focus(); } catch { /* ignore */ }
          openSessionById(sessionId);
          try { note.close(); } catch { /* ignore */ }
        };
      } catch { /* permission/engine refused */ }
    }

    function requestSystemPermission() {
      try {
        if (typeof Notification === 'undefined') return Promise.resolve('unsupported');
        if (Notification.permission !== 'default') return Promise.resolve(Notification.permission);
        return Notification.requestPermission();
      } catch {
        return Promise.resolve('denied');
      }
    }

    async function tick() {
      if (watcher.inFlight) return;
      watcher.inFlight = true;
      try {
        const response = await fetch(API + '/radar', { credentials: 'same-origin' });
        if (!response.ok) return;
        const payload = await response.json();
        if (!payload || payload.ok !== true) return;
        const cfg = payload.config || {};
        watcher.cfg = cfg;
        watcher.system = !!(cfg.system && cfg.system.enabled === true);
        const journal = Array.isArray(payload.journal) ? payload.journal : [];
        for (const entry of journal) {
          if (!entry || typeof entry.at !== 'number') continue;
          if (entry.at <= watcher.lastAt) continue;
          if (cfg.enabled === false || (cfg.events && cfg.events[entry.kind] === false)) {
            watcher.lastAt = Math.max(watcher.lastAt, entry.at);
            continue;
          }
          if (watcher.system) showSystemNotification(entry.kind, entry.title, entry.body, entry.location, entry.session);
          watcher.lastAt = Math.max(watcher.lastAt, entry.at);
        }
        if (journal.length > 0 && watcher.lastAt === 0) {
          const newest = journal.reduce((m, e) => (e && typeof e.at === 'number' && e.at > m ? e.at : m), 0);
          watcher.lastAt = newest;
        }
      } catch { /* offline is fine */ } finally {
        watcher.inFlight = false;
      }
    }

    function startWatcher() {
      if (watcher.timer !== null) return;
      void tick();
      watcher.timer = window.setInterval(() => { void tick(); }, 2500);
    }

    /* ------------------------------------------------- settings primitives */
    function Toggle(props) {
      const on = props.value === true;
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': on,
        disabled: props.disabled === true,
        onClick: () => { if (props.disabled !== true) props.onChange(!on); },
        style: {
          flex: '0 0 auto',
          width: '42px',
          height: '24px',
          padding: '0',
          borderRadius: '999px',
          border: '1px solid ' + (on ? C.accent : C.border),
          background: on ? C.accent : 'transparent',
          cursor: props.disabled ? 'default' : 'pointer',
          opacity: props.disabled ? 0.5 : 1,
          position: 'relative',
          transition: 'background .15s, border-color .15s',
        },
      }, h('span', {
        style: {
          position: 'absolute',
          top: '2px',
          left: on ? '20px' : '2px',
          width: '18px',
          height: '18px',
          borderRadius: '50%',
          background: on ? '#fff' : C.muted,
          transition: 'left .15s',
        },
      }));
    }

    function Row(props) {
      return h('div', {
        style: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '14px',
          padding: props.tight ? '6px 0' : '10px 0',
          borderTop: props.first ? 'none' : '1px solid ' + C.cardBorder,
        },
      },
        h('div', { style: { minWidth: 0 } },
          h('div', { style: { fontSize: '13.5px', color: C.text } }, props.label),
          props.hint ? h('div', { style: { fontSize: '12px', color: C.faint, marginTop: '2px' } }, props.hint) : null,
        ),
        props.children,
      );
    }

    function Card(props) {
      return h('section', {
        style: {
          background: C.card,
          border: '1px solid ' + C.cardBorder,
          borderRadius: '12px',
          padding: '14px 16px',
          marginBottom: '14px',
        },
      },
        h('h3', {
          style: {
            margin: '0 0 4px',
            fontSize: '12px',
            fontWeight: 600,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            color: C.muted,
          },
        }, props.title),
        props.desc ? h('p', { style: { margin: '0 0 6px', fontSize: '12px', color: C.faint } }, props.desc) : null,
        props.children,
      );
    }

    function NumInput(props) {
      return h('input', {
        type: 'number',
        value: props.value == null ? '' : String(props.value),
        min: props.min,
        onChange: (e) => props.onChange(e.target.value),
        style: {
          width: '92px',
          padding: '5px 8px',
          borderRadius: '8px',
          border: '1px solid ' + C.border,
          background: C.inputBg,
          color: C.text,
          fontSize: '13px',
          textAlign: 'right',
        },
      });
    }

    function TextInput(props) {
      return h('input', {
        type: 'text',
        value: props.value == null ? '' : String(props.value),
        placeholder: props.placeholder || '',
        onChange: (e) => props.onChange(e.target.value),
        style: {
          width: '200px',
          padding: '5px 8px',
          borderRadius: '8px',
          border: '1px solid ' + C.border,
          background: C.inputBg,
          color: C.text,
          fontSize: '13px',
        },
      });
    }

    function ChannelCard(props) {
      return h('div', {
        style: {
          border: '1px solid ' + (props.enabled ? C.accent : C.cardBorder),
          background: props.enabled ? C.accentSoft : 'transparent',
          borderRadius: '12px',
          padding: '12px 14px',
          marginTop: '10px',
        },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' } },
          h('div', { style: { minWidth: 0 } },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
              h('span', { style: { fontSize: '14px', fontWeight: 600, color: C.text } }, props.name),
              h('span', {
                style: {
                  fontSize: '10.5px',
                  fontWeight: 700,
                  letterSpacing: '0.04em',
                  padding: '1px 7px',
                  borderRadius: '999px',
                  color: props.enabled ? C.accent : C.faint,
                  border: '1px solid ' + (props.enabled ? C.accent : C.border),
                },
              }, props.badge),
            ),
            h('div', { style: { fontSize: '12px', color: C.faint, marginTop: '4px', lineHeight: '16px' } }, props.desc),
          ),
          h(Toggle, { value: props.enabled, onChange: props.onToggle }),
        ),
        props.children ? h('div', { style: { marginTop: '10px' } }, props.children) : null,
      );
    }

    function Badge(props) {
      const color = props.tone === 'ok' ? C.accent : props.tone === 'warn' ? C.warn : props.tone === 'bad' ? C.danger : C.faint;
      return h('span', {
        style: {
          fontSize: '12px',
          padding: '2px 9px',
          borderRadius: '999px',
          color,
          border: '1px solid ' + color,
          whiteSpace: 'nowrap',
        },
      }, props.text);
    }

    function SettingsPage(props) {
      const t = props.t;
      const [local, setLocal] = React.useState(null);
      const [status, setStatus] = React.useState('');
      const [dirty, setDirty] = React.useState(false);

      React.useEffect(() => {
        let alive = true;
        fetch(API + '/radar', { credentials: 'same-origin' })
          .then((r) => r.json())
          .then((payload) => {
            if (!alive || !payload || payload.ok !== true) return;
            setLocal({ config: payload.config });
          })
          .catch(() => {});
        return () => { alive = false; };
      }, []);

      if (local === null) {
        return h('div', { style: { padding: '16px', color: C.muted } }, h('p', null, textKey(t, 'load.error')));
      }

      const cfg = local.config;
      const set = (mutator) => {
        const next = JSON.parse(JSON.stringify(cfg));
        mutator(next);
        setLocal({ config: next });
        setDirty(true);
        setStatus('');
      };

      const save = () => {
        setStatus(textKey(t, 'btn.saving'));
        fetch(API + '/config', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ config: local.config }),
        })
          .then((r) => r.json())
          .then((payload) => {
            if (payload && payload.ok) {
              setLocal({ config: payload.config });
              setDirty(false);
              setStatus(textKey(t, 'btn.saved'));
            } else {
              setStatus('[' + (payload && payload.reason) + ']');
            }
          })
          .catch(() => setStatus('error'));
      };

      const test = () => {
        fetch(API + '/test', { method: 'POST', credentials: 'same-origin' })
          .then((r) => r.json())
          .then((payload) => setStatus(payload && payload.ok === true
            ? textKey(t, payload.submitted === true ? 'test.sent' : 'test.noToast')
            : 'error'))
          .catch(() => setStatus('error'));
      };

      const supported = typeof Notification !== 'undefined';
      const perm = supported ? Notification.permission : 'unsupported';
      const permTone = perm === 'granted' ? 'ok' : perm === 'denied' ? 'bad' : 'muted';
      const permText = { granted: 'sys.granted', denied: 'sys.denied', default: 'sys.default' }[perm] || 'sys.unsupported';

      const buttonStyle = (primary) => ({
        padding: '7px 18px',
        borderRadius: '9px',
        fontSize: '13px',
        fontWeight: 600,
        cursor: 'pointer',
        border: '1px solid ' + (primary ? C.accent : C.border),
        background: primary ? C.accent : 'transparent',
        color: primary ? '#fff' : C.text,
      });

      return h('div', { style: { padding: '6px 16px 28px', maxWidth: '760px', color: C.text } },
        h('div', { style: { marginBottom: '14px' } },
          h('h2', { style: { margin: '0 0 3px', fontSize: '19px', fontWeight: 650 } }, textKey(t, 'nav.title')),
          h('p', { style: { margin: 0, fontSize: '13px', color: C.muted } }, textKey(t, 'nav.hint')),
        ),

        h(Card, { title: textKey(t, 'section.events'), desc: textKey(t, 'events.hint') },
          h(Row, { label: textKey(t, 'opt.enabled'), hint: textKey(t, 'opt.enabledHint'), first: true },
            h(Toggle, { value: cfg.enabled, onChange: (v) => set((n) => { n.enabled = v; }) }),
          ),
          h(Row, { label: textKey(t, 'opt.rootsOnly'), hint: textKey(t, 'opt.rootsOnlyHint') },
            h(Toggle, { value: cfg.rootsOnly, onChange: (v) => set((n) => { n.rootsOnly = v; }) }),
          ),
          ['turnStart', 'finished', 'aborted', 'error', 'waiting'].map((kind) =>
            h(Row, { key: kind, label: textKey(t, 'events.' + kind), tight: true },
              h(Toggle, { value: cfg.events[kind] === true, onChange: (v) => set((n) => { n.events[kind] = v; }) }),
            ),
          ),
        ),

        h(Card, { title: textKey(t, 'section.channels') },
          h(ChannelCard, {
            name: textKey(t, 'toast.name'),
            desc: textKey(t, 'toast.desc'),
            enabled: cfg.toast.enabled,
            badge: cfg.toast.enabled ? textKey(t, 'badge.on') : textKey(t, 'badge.off'),
            onToggle: (v) => set((n) => { n.toast.enabled = v; }),
          },
            h(Row, { label: textKey(t, 'toast.persistent'), first: true, tight: true },
              h(Toggle, { value: cfg.toast.persistent, onChange: (v) => set((n) => { n.toast.persistent = v; }) }),
            ),
            h(Row, { label: textKey(t, 'toast.iconPath'), tight: true },
              h(TextInput, { value: cfg.toast.iconPath, placeholder: 'C:\\path\\icon.png', onChange: (v) => set((n) => { n.toast.iconPath = v; }) }),
            ),
          ),
          h(ChannelCard, {
            name: textKey(t, 'sys.name'),
            desc: textKey(t, 'sys.desc'),
            enabled: cfg.system.enabled,
            badge: cfg.system.enabled ? textKey(t, 'badge.on') : textKey(t, 'badge.off'),
            onToggle: (v) => set((n) => { n.system.enabled = v; }),
          },
            h(Row, { label: textKey(t, 'sys.permission'), first: true, tight: true },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
                h(Badge, { text: textKey(t, permText), tone: permTone }),
                (supported && perm !== 'granted')
                  ? h('button', {
                    type: 'button',
                    onClick: () => { requestSystemPermission().then(() => setLocal({ config: { ...cfg } })); },
                    style: { ...buttonStyle(false), padding: '4px 12px', fontSize: '12px' },
                  }, textKey(t, 'sys.request'))
                  : null,
              ),
            ),
            (perm === 'denied') ? h('div', { style: { fontSize: '12px', color: C.warn, marginTop: '6px' } }, textKey(t, 'sys.deniedHint')) : null,
          ),
        ),

        h(Card, { title: textKey(t, 'section.advanced') },
          h(Row, { label: textKey(t, 'opt.cooldown'), first: true },
            h(NumInput, { value: Math.round((cfg.cooldownMs || 0) / 1000), min: 0, onChange: (v) => set((n) => { n.cooldownMs = Math.max(0, Number(v) || 0) * 1000; }) }),
          ),
          h(Row, { label: textKey(t, 'opt.summary') },
            h(NumInput, { value: cfg.summaryMaxChars, min: 1, onChange: (v) => set((n) => { n.summaryMaxChars = Math.max(1, Number(v) || 48); }) }),
          ),
          h(Row, { label: textKey(t, 'opt.titlePrefix') },
            h(TextInput, { value: cfg.titlePrefix, onChange: (v) => set((n) => { n.titlePrefix = v; }) }),
          ),
        ),

        h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', marginTop: '4px' } },
          h('button', { type: 'button', onClick: save, style: buttonStyle(true) }, textKey(t, 'btn.save')),
          h('button', { type: 'button', onClick: test, style: buttonStyle(false) }, textKey(t, 'btn.test')),
          h('span', { style: { fontSize: '12.5px', color: dirty ? C.warn : C.muted } }, status || (dirty ? '*' : '')),
        ),
      );
    }

    /* -------------------------------------------------------------- wiring */
    function apply(ctx) {
      appCtx = ctx;
      const locale = ctx.locale;
      if (locale && typeof locale.register === 'function') {
        ctx.effect(() => locale.register(NS, { zh, en }), 'task-radar dictionaries');
      }

      if (ctx.slots && typeof ctx.slots.inject === 'function') {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'task-radar',
          order: 38,
          locale: NS,
          label: () => {
            try { return locale.bind(NS)('nav.title'); } catch { return zh['nav.title']; }
          },
        }, SettingsPage));
      }

      startWatcher();
      // Browsers only show the notification permission prompt inside a user
      // gesture; ask on the first click/keypress when the channel is on.
      try {
        const tryGrant = () => {
          if (typeof Notification === 'undefined' || Notification.permission !== 'default') {
            document.removeEventListener('pointerdown', tryGrant);
            document.removeEventListener('keydown', tryGrant);
            return;
          }
          if (watcher.system === true) { void requestSystemPermission(); }
        };
        document.addEventListener('pointerdown', tryGrant);
        document.addEventListener('keydown', tryGrant);
        ctx.effect(() => () => {
          try {
            document.removeEventListener('pointerdown', tryGrant);
            document.removeEventListener('keydown', tryGrant);
          } catch { /* ignore */ }
        }, 'task-radar permission gesture');
      } catch { /* non-DOM host; the Settings button still works */ }

      ctx.effect(() => () => {
        if (watcher.timer !== null) { window.clearInterval(watcher.timer); watcher.timer = null; }
      }, 'task-radar watcher cleanup');
    }

    const moduleExports = {
      name: 'task-radar',
      inject: ['slots', 'locale', 'uiWorkspace'],
      apply,
      __internals: { NS, API, zh, en, textKey, tick, watcher, SettingsPage, showSystemNotification, openSessionById },
    };
    return moduleExports;
  },
});
