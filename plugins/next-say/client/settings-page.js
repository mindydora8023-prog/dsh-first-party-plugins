/**
 * Settings page for dsh-plugin-next-say.
 *
 * Inlined into `lib/client.js` by `tools/build-client.mjs`. Pure ASCII only.
 */

const rowStyle = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 16,
  padding: '10px 0',
  borderBottom: '1px solid var(--dsw-alias-border-secondary, #8882)',
};
const labelStyle = { fontSize: 13, color: 'var(--dsw-alias-label-primary, inherit)' };
const hintStyle = { fontSize: 12, marginTop: 2, color: 'var(--dsw-alias-label-secondary, #6b7280)' };
const inputStyle = {
  flexShrink: 0,
  minWidth: 110,
  padding: '4px 8px',
  borderRadius: 6,
  border: '1px solid var(--dsw-alias-border-primary, #8884)',
  background: 'var(--dsw-alias-bg-primary, transparent)',
  color: 'inherit',
  font: 'inherit',
};

function SettingsPage(props) {
  const t = typeof props.t === 'function'
    ? props.t
    : (key) => (Object.prototype.hasOwnProperty.call(zh, key) ? zh[key] : key);
  const [value, setValue] = React.useState(settingsStore.value);
  const [status, setStatus] = React.useState('');
  const [now, setNow] = React.useState(() => Date.now());
  const [edits, setEdits] = React.useState({});
  const editsRef = React.useRef({});
  const editVersions = React.useRef({});
  const saveRevision = React.useRef(0);
  const alive = React.useRef(true);

  React.useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  React.useEffect(() => settingsStore.subscribe(() => setValue(settingsStore.value)), []);
  React.useEffect(() => {
    if (settingsStore.value === null) void loadSettings();
  }, []);

  const save = React.useCallback(async (patch) => {
    const revision = ++saveRevision.current;
    setStatus('saving');
    try {
      await saveSettings(patch);
      if (alive.current && revision === saveRevision.current) setStatus('saved');
      return true;
    } catch (error) {
      if (alive.current && revision === saveRevision.current) setStatus(error && error.code === 'settings-uncertain' ? 'uncertain' : 'failed');
      return false;
    }
  }, []);

  const reloadSettings = async () => {
    if (status === 'saving' || status === 'loading') return;
    const revision = ++saveRevision.current;
    setStatus('loading');
    const loaded = await loadSettings();
    if (!alive.current || revision !== saveRevision.current) return;
    setStatus(settingsStore.writeUncertain ? 'uncertain' : loaded ? 'saved' : 'failed');
  };

  const current = value || DEFAULT_SETTINGS;
  const locked = settingsStore.writeUncertain === true;
  const editField = (key, text) => {
    editVersions.current = { ...editVersions.current, [key]: {} };
    editsRef.current = { ...editsRef.current, [key]: text };
    setEdits(editsRef.current);
  };
  const clearSavedEdits = (snapshot, versions = editVersions.current) => {
    if (!alive.current) return;
    const next = { ...editsRef.current };
    for (const [key, text] of Object.entries(snapshot)) {
      if (next[key] === text && editVersions.current[key] === versions[key]) delete next[key];
    }
    editsRef.current = next;
    setEdits(next);
  };
  const fieldText = (key) => Object.hasOwn(edits, key) ? edits[key] : String(current[key] ?? '');
  const commitNumber = async (key) => {
    if (!Object.hasOwn(editsRef.current, key)) return;
    const text = editsRef.current[key];
    const versions = editVersions.current;
    if (await save({ [key]: clampTo(key, text) })) clearSavedEdits({ [key]: text }, versions);
  };
  const providerText = fieldText('provider');
  const modelText = fieldText('model');
  const routeComplete = (providerText.trim() === '') === (modelText.trim() === '');
  const routeChanged = providerText.trim() !== current.provider || modelText.trim() !== current.model;
  const commitRoute = async () => {
    const snapshot = {
      provider: Object.hasOwn(editsRef.current, 'provider') ? editsRef.current.provider : current.provider,
      model: Object.hasOwn(editsRef.current, 'model') ? editsRef.current.model : current.model,
    };
    const versions = editVersions.current;
    if ((snapshot.provider.trim() === '') !== (snapshot.model.trim() === '')) return;
    if (await save({ provider: snapshot.provider.trim(), model: snapshot.model.trim() })) clearSavedEdits(snapshot, versions);
  };
  const paused = isPaused(current, now);
  React.useEffect(() => {
    if (!paused) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [paused]);
  const remaining = paused ? Math.max(0, Math.ceil((Number(current.pausedUntil) - now) / 1000)) : 0;
  const countdown = remaining >= 60
    ? `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`
    : String(remaining);

  const toggle = (key) => (event) => { void save({ [key]: event.target.checked }); };
  const number = (key, min, max, label) => h('input', {
    type: 'number',
    min,
    max,
    disabled: locked,
    'aria-label': t(label),
    style: inputStyle,
    value: fieldText(key),
    onChange: (event) => editField(key, event.target.value),
    onBlur: () => { void commitNumber(key); },
    onKeyDown: (event) => {
      if (event.isComposing) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        event.currentTarget.blur();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        clearSavedEdits({ [key]: editsRef.current[key] });
      }
    },
  });
  const select = (key, options) => h('select', {
    'aria-label': t('settingsMode'),
    disabled: locked,
    style: inputStyle,
    value: current[key],
    onChange: (event) => { void save({ [key]: event.target.value }); },
  }, options.map((option) => h('option', { key: option.value, value: option.value }, t(option.label))));

  return h('div', { style: { padding: '4px 0 24px' } },
    h('h2', { style: { fontSize: 16, margin: '0 0 6px' } }, t('settingsTitle')),
    h('p', { style: { fontSize: 12, margin: '0 0 4px', ...hintStyle } }, t('settingsIntro')),
    h('p', { style: { fontSize: 12, margin: '0 0 8px', ...hintStyle } }, t('costWarning')),
    h('p', { style: { ...hintStyle, margin: '0 0 16px' } }, t('settingsEditHint')),

    settingsStore.error === undefined ? null : h('p', {
      style: { fontSize: 12, margin: '0 0 16px', color: 'var(--dsw-alias-state-warning-primary, #b45309)' },
    }, t('settingsLoadFailed')),

    h('div', { style: rowStyle },
      h('div', null, h('div', { style: labelStyle }, t('settingsEnabled')), h('div', { style: hintStyle }, t('settingsEnabledHint'))),
      h('input', { type: 'checkbox', disabled: locked, 'aria-label': t('settingsEnabled'), checked: current.enabled === true, onChange: toggle('enabled') })),

    h('div', { style: rowStyle },
      h('div', null, h('div', { style: labelStyle }, t('settingsMode')), h('div', { style: hintStyle }, t('settingsModeHint'))),
      select('mode', [
        { value: 'auto', label: 'settingsModeAuto' },
        { value: 'manual', label: 'settingsModeManual' },
      ])),

    h('div', { style: rowStyle },
      h('div', null, h('div', { style: labelStyle }, t('settingsMaxChars')), h('div', { style: hintStyle }, t('settingsMaxCharsHint'))),
      number('maxSuggestionChars', 20, 400, 'settingsMaxChars')),

    h('div', { style: rowStyle },
      h('div', null, h('div', { style: labelStyle }, t('settingsContextMessages')), h('div', { style: hintStyle }, t('settingsContextMessagesHint'))),
      number('contextMessages', 2, 20, 'settingsContextMessages')),

    h('div', { style: rowStyle },
      h('div', null, h('div', { style: labelStyle }, t('settingsContextChars')), h('div', { style: hintStyle }, t('settingsContextCharsHint'))),
      number('contextChars', 1000, 20000, 'settingsContextChars')),

    h('div', { style: rowStyle },
      h('div', null, h('div', { style: labelStyle }, t('settingsTimeout')), h('div', { style: hintStyle }, t('settingsTimeoutHint'))),
      number('timeoutMs', 2000, 60000, 'settingsTimeout')),

    h('div', { style: rowStyle },
      h('div', null, h('div', { style: labelStyle }, t('settingsHistory')), h('div', { style: hintStyle }, t('settingsHistoryHint'))),
      h('input', { type: 'checkbox', disabled: locked, 'aria-label': t('settingsHistory'), checked: current.historyEnabled === true, onChange: toggle('historyEnabled') })),

    h('div', { style: rowStyle },
      h('div', null, h('div', { style: labelStyle }, t('settingsHistoryMinChars')), h('div', { style: hintStyle }, t('settingsHistoryMinCharsHint'))),
      number('historyMinChars', 1, 8, 'settingsHistoryMinChars')),

    h('div', { style: rowStyle },
      h('div', null,
        h('div', { style: labelStyle }, t(paused ? 'settingsResume' : 'settingsPause')),
        h('div', { style: hintStyle }, t(paused ? 'settingsResumeHint' : 'settingsPauseHint'))),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
        paused ? h('span', { style: hintStyle }, countdown) : null,
        h('button', {
          type: 'button',
          disabled: locked,
          style: { ...inputStyle, cursor: locked ? 'default' : 'pointer' },
          onClick: () => {
            const freshNow = Date.now();
            setNow(freshNow);
            void save({ pausedUntil: paused ? 0 : pauseUntil(freshNow, 10) });
          },
        }, t(paused ? 'settingsResume' : 'settingsPause')))),

    h('div', { style: { ...rowStyle, borderBottom: 'none' } },
      h('div', null, h('div', { style: labelStyle }, t('settingsProvider')), h('div', { style: hintStyle }, t('settingsProviderHint'))),
      h('input', {
        type: 'text',
        disabled: locked,
        style: { ...inputStyle, minWidth: 180 },
        placeholder: current.provider === '' ? t('settingsInherit') : '',
        'aria-label': t('settingsProvider'),
        'aria-describedby': 'next-say-route-hint',
        'aria-invalid': !routeComplete,
        value: providerText,
        onChange: (event) => editField('provider', event.target.value),
      })),

    h('div', { style: { ...rowStyle, borderBottom: 'none' } },
      h('div', null, h('div', { style: labelStyle }, t('settingsModel')), h('div', { style: hintStyle }, t('settingsModelHint'))),
      h('input', {
        type: 'text',
        disabled: locked,
        style: { ...inputStyle, minWidth: 180 },
        placeholder: current.model === '' ? t('settingsInherit') : '',
        'aria-label': t('settingsModel'),
        'aria-describedby': 'next-say-route-hint',
        'aria-invalid': !routeComplete,
        value: modelText,
        onChange: (event) => editField('model', event.target.value),
      })),

    h('div', { style: rowStyle },
      h('p', { id: 'next-say-route-hint', style: { ...hintStyle, margin: 0 } }, t(routeComplete ? 'settingsRouteHint' : 'settingsRouteIncomplete')),
      h('button', {
        type: 'button',
        style: { ...inputStyle, cursor: routeChanged && routeComplete && !locked ? 'pointer' : 'default' },
        disabled: !routeChanged || !routeComplete || locked,
        'aria-describedby': 'next-say-route-hint',
        onClick: () => { void commitRoute(); },
      }, t('settingsSaveRoute'))),

    h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, paddingTop: 14 } },
      h('button', {
        type: 'button',
        style: { ...inputStyle, cursor: locked ? 'default' : 'pointer' },
        disabled: locked,
        onClick: () => {
          editsRef.current = {};
          editVersions.current = {};
          setEdits({});
          void save({ reset: true });
        },
      }, t('settingsReset')),
      h('span', { style: hintStyle }, t('settingsResetHint')),
      h('span', { role: 'status', 'aria-live': 'polite', style: hintStyle }, locked ? t('settingsUncertain') : status === 'loading' ? t('settingsReloading') : status === 'saving' ? t('settingsSaving') : status === 'failed' ? t('settingsFailed') : Object.keys(edits).length > 0 ? t('settingsUnsaved') : status === 'saved' ? t('settingsSaved') : ''),
      locked || settingsStore.error !== undefined ? h('button', {
        type: 'button', style: { ...inputStyle, cursor: 'pointer' },
        disabled: status === 'loading' || status === 'saving',
        onClick: () => { void reloadSettings(); },
      }, t('settingsReload')) : null),
  );
}
