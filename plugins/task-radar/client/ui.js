/**
 * React UI primitives, SettingsPage, and NoticeStack for dsh-plugin-task-radar.
 *
 * Fixes:
 * - `NoticeStack` uses the active locale for its dismiss aria-label instead of
 *   hardcoded Chinese.
 * - `NumInput` preserves partial string drafts while typing so intermediate
 *   inputs never jump `NaN -> 0` or swallow trailing decimal points.
 * - Quiet-hour `HH:MM` fields highlight invalid format inline and refuse save
 *   with a clear localized message instead of silently resetting.
 *
 * ASCII only.
 */

export const C = {
  text: 'var(--dsw-alias-label-primary)',
  muted: 'var(--dsw-alias-label-secondary)',
  faint: 'var(--dsw-alias-label-tertiary)',
  border: 'var(--dsw-alias-border-l2)',
  card: 'var(--dsw-alias-settings-card-fill)',
  cardBorder: 'var(--dsw-alias-settings-card-stroke)',
  accent: 'var(--dsw-alias-state-business-primary)',
  accentSoft: 'var(--dsw-alias-state-business-tertiary)',
  onAccent: 'var(--dsw-alias-label-on-color)',
  warn: 'var(--dsw-alias-state-warn-primary)',
  danger: 'var(--dsw-alias-state-error-primary)',
  inputBg: 'var(--dsw-alias-bg-base)',
};

export function Toggle(props) {
  const on = props.value === true;
  return h('button', {
    type: 'button',
    role: 'switch',
    'aria-checked': on,
    'aria-label': props.label,
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
      background: on ? C.onAccent : C.muted,
      transition: 'left .15s',
    },
  }));
}

export function Row(props) {
  const child = props.children;
  const control = child && [Toggle, NumInput, TextInput].includes(child.type)
    ? React.cloneElement(child, { label: props.label })
    : child;
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
    control,
  );
}

export function Card(props) {
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

function formatNumericDraft(value, scale) {
  if (value === '' || value == null) return '';
  if (typeof value === 'string') return value;
  return Number.isFinite(value) ? String(value / scale) : '';
}

export function NumInput(props) {
  const scale = typeof props.scale === 'number' && props.scale > 0 ? props.scale : 1;
  const [draft, setDraft] = React.useState(() => formatNumericDraft(props.value, scale));
  const lastCommitted = React.useRef(props.value);

  let shown = draft;
  if (props.value !== lastCommitted.current) {
    lastCommitted.current = props.value;
    shown = formatNumericDraft(props.value, scale);
    if (draft !== shown) setDraft(shown);
  }

  return h('input', {
    type: 'number',
    'aria-label': props.label,
    value: shown,
    min: props.min,
    max: props.max,
    step: props.step,
    onChange: (e) => {
      const raw = String(e.target.value);
      setDraft(raw);
      if (raw.trim() === '') {
        lastCommitted.current = '';
        props.onChange('');
        return;
      }
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) {
        const committed = scale === 1 ? parsed : Math.round(parsed * scale);
        lastCommitted.current = committed;
        props.onChange(committed);
      }
    },
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

export function TextInput(props) {
  return h('input', {
    type: 'text',
    'aria-label': props.label,
    'aria-invalid': props.invalid === true ? true : undefined,
    value: props.value == null ? '' : String(props.value),
    placeholder: props.placeholder || '',
    onChange: (e) => props.onChange(e.target.value),
    style: {
      width: '200px',
      padding: '5px 8px',
      borderRadius: '8px',
      border: '1px solid ' + (props.invalid ? C.danger : C.border),
      background: C.inputBg,
      color: C.text,
      fontSize: '13px',
    },
  });
}

export function ChannelCard(props) {
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
      h(Toggle, { label: props.name, value: props.enabled, onChange: props.onToggle }),
    ),
    props.children ? h('div', { style: { marginTop: '10px' } }, props.children) : null,
  );
}

export function Badge(props) {
  const color = props.tone === 'ok'
    ? C.accent
    : props.tone === 'warn'
      ? C.warn
      : props.tone === 'bad'
        ? C.danger
        : C.faint;
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

export function SettingsPage(props) {
  const t = props.t;
  const [local, setLocal] = React.useState(settingsInitialState);
  const model = React.useRef(null);
  React.useEffect(() => {
    const current = createSettingsModel();
    model.current = current;
    const unsubscribe = current.subscribe(setLocal);
    void current.load();
    return () => {
      unsubscribe();
      current.dispose();
      model.current = null;
    };
  }, []);

  const buttonStyle = (primary) => ({
    padding: '7px 18px',
    borderRadius: '9px',
    fontSize: '13px',
    fontWeight: 600,
    cursor: 'pointer',
    border: '1px solid ' + (primary ? C.accent : C.border),
    background: primary ? C.accent : 'transparent',
    color: primary ? C.onAccent : C.text,
  });

  if (local.config === null) {
    return h('div', { style: { padding: '16px', color: C.muted }, role: 'status', 'aria-live': 'polite' },
      h('p', null, textKey(t, local.loading ? 'load.loading' : 'load.error')),
      !local.loading
        ? h('button', { type: 'button', style: buttonStyle(false), onClick: () => { void model.current?.load(); } }, textKey(t, 'btn.retry'))
        : null,
    );
  }

  const cfg = local.config;
  const dirty = local.dirty;
  const quietStartValid = validClock(cfg.quiet.start);
  const quietEndValid = validClock(cfg.quiet.end);
  const quietInvalid = !quietStartValid || !quietEndValid;
  const status = local.status ? textKey(t, local.status) + (local.reason ? ' [' + local.reason + ']' : '') : '';
  const set = (mutator) => model.current?.set(mutator);
  const save = () => { void model.current?.save(); };
  const test = () => { void model.current?.test(); };

  const supported = typeof Notification !== 'undefined';
  const perm = supported ? Notification.permission : 'unsupported';
  const permTone = perm === 'granted' ? 'ok' : perm === 'denied' ? 'bad' : 'muted';
  const permText = { granted: 'sys.granted', denied: 'sys.denied', default: 'sys.default' }[perm] || 'sys.unsupported';

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
        h(Row, { label: textKey(t, 'toast.duration'), hint: textKey(t, 'toast.durationHint'), tight: true },
          h(NumInput, {
            value: cfg.toast.durationMs,
            scale: 1000,
            min: 3,
            max: 30,
            step: 1,
            onChange: (v) => set((n) => { n.toast.durationMs = v; }),
          }),
        ),
      ),
      h(ChannelCard, {
        name: textKey(t, 'page.name'),
        desc: textKey(t, 'page.desc'),
        enabled: cfg.page.enabled,
        badge: cfg.page.enabled ? textKey(t, 'badge.on') : textKey(t, 'badge.off'),
        onToggle: (v) => set((n) => { n.page.enabled = v; }),
      }),
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
            (supported && perm === 'default')
              ? h('button', {
                type: 'button',
                onClick: () => {
                  const current = model.current;
                  void requestSystemPermission().then(() => current?.refreshPermission());
                },
                style: { ...buttonStyle(false), padding: '4px 12px', fontSize: '12px' },
              }, textKey(t, 'sys.request'))
              : null,
          ),
        ),
        (perm === 'denied')
          ? h('div', { style: { fontSize: '12px', color: C.warn, marginTop: '6px' } }, textKey(t, 'sys.deniedHint'))
          : null,
      ),
    ),

    h(Card, { title: textKey(t, 'section.advanced') },
      h(Row, { label: textKey(t, 'opt.cooldown'), first: true },
        h(NumInput, {
          value: cfg.cooldownMs,
          scale: 1000,
          min: 0,
          max: 86400,
          step: 0.001,
          onChange: (v) => set((n) => { n.cooldownMs = v; }),
        }),
      ),
      h(Row, { label: textKey(t, 'opt.summary') },
        h(NumInput, {
          value: cfg.summaryMaxChars,
          scale: 1,
          min: 1,
          max: 4096,
          step: 1,
          onChange: (v) => set((n) => { n.summaryMaxChars = v; }),
        }),
      ),
      h(Row, { label: textKey(t, 'opt.titlePrefix') },
        h(TextInput, { value: cfg.titlePrefix, onChange: (v) => set((n) => { n.titlePrefix = v; }) }),
      ),
    ),

    h(Card, { title: textKey(t, 'quiet.title'), desc: textKey(t, 'quiet.hint') },
      h(Row, { label: textKey(t, 'quiet.enabled'), first: true },
        h(Toggle, { value: cfg.quiet.enabled, onChange: (v) => set((n) => { n.quiet.enabled = v; }) }),
      ),
      h(Row, { label: textKey(t, 'quiet.start'), tight: true },
        h(TextInput, {
          value: cfg.quiet.start,
          placeholder: '22:00',
          invalid: !quietStartValid,
          onChange: (v) => set((n) => { n.quiet.start = v; }),
        }),
      ),
      h(Row, { label: textKey(t, 'quiet.end'), tight: true },
        h(TextInput, {
          value: cfg.quiet.end,
          placeholder: '08:00',
          invalid: !quietEndValid,
          onChange: (v) => set((n) => { n.quiet.end = v; }),
        }),
      ),
      quietInvalid
        ? h('div', { role: 'alert', style: { fontSize: '12px', color: C.danger, marginTop: '6px' } }, textKey(t, 'quiet.invalid'))
        : null,
    ),

    h('p', { style: { fontSize: '12px', color: C.faint } }, textKey(t, 'test.hint')),
    h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px', marginTop: '4px' } },
      h('button', {
        type: 'button',
        onClick: save,
        disabled: Boolean(local.busy) || !dirty,
        style: { ...buttonStyle(true), opacity: local.busy || !dirty ? 0.5 : 1 },
      }, textKey(t, 'btn.save')),
      h('button', {
        type: 'button',
        onClick: test,
        disabled: Boolean(local.busy),
        style: { ...buttonStyle(false), opacity: local.busy ? 0.5 : 1 },
      }, textKey(t, 'btn.test')),
      h('span', {
        role: 'status',
        'aria-live': 'polite',
        style: { fontSize: '12.5px', color: local.status === 'quiet.invalid' ? C.danger : (dirty ? C.warn : C.muted) },
      }, status || (dirty ? '*' : '')),
    ),
  );
}

export function NoticeStack(props) {
  const [items, setItems] = React.useState(() => notices.slice());
  React.useEffect(() => {
    const listener = (next) => setItems(next);
    noticeListeners.add(listener);
    return () => noticeListeners.delete(listener);
  }, []);
  if (items.length === 0) return null;
  const dismissLabel = textKey(props && props.t, 'notice.dismiss');
  return h('div', {
    style: {
      position: 'fixed',
      right: '16px',
      bottom: '16px',
      zIndex: 30,
      display: 'flex',
      flexDirection: 'column',
      gap: '8px',
      width: 'min(360px, calc(100vw - 32px))',
    },
  }, items.map((item) => h('div', {
    key: item.id,
    style: {
      background: C.card,
      color: C.text,
      border: '1px solid ' + C.cardBorder,
      borderRadius: '12px',
      padding: '10px 12px',
    },
  },
    h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'center' } },
      h('strong', { style: { fontSize: '13px' } }, item.title),
      h('button', {
        type: 'button',
        'aria-label': dismissLabel,
        onClick: () => dismissNotice(item.id),
        style: { border: 0, background: 'transparent', color: C.muted, cursor: 'pointer', fontSize: '16px' },
      }, '\u00d7'),
    ),
    h('button', {
      type: 'button',
      onClick: () => activateNotice(item.id),
      style: {
        display: 'block',
        width: '100%',
        textAlign: 'left',
        border: 0,
        background: 'transparent',
        color: C.text,
        cursor: 'pointer',
        padding: '4px 0 0',
        fontSize: '12.5px',
      },
    },
      item.body,
      item.location ? h('div', { style: { color: C.faint, marginTop: '4px' } }, item.location) : null,
    ),
  )));
}
