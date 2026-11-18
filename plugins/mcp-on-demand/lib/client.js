/**
 * Settings page for dsh-plugin-mcp-on-demand.
 *
 * Lists every server the plugin can mount, whether it is mounted now, and
 * lets the user enable or release it. The model keeps the same two operations
 * through mcpod_enable / mcpod_disable; this page calls that same route.
 *
 * ASCII only: Chinese copy is \u escaped.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-mcp-on-demand',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const NS = 'mcpOnDemand'
    const API = '/api/mcp-on-demand/servers'

    const zh = {
      'nav.title': 'MCP \u670d\u52a1\u5668',
      'nav.hint': '\u9ed8\u8ba4\u4e0d\u6302\u8f7d\u3002\u542f\u7528\u540e\uff0c\u8fd9\u53f0\u670d\u52a1\u5668\u7684\u5de5\u5177\u4f1a\u8fdb\u5165\u4e0b\u4e00\u8f6e\u8bf7\u6c42\uff1b\u5230\u70b9\u6216\u70b9\u91ca\u653e\u540e\u6536\u56de\u3002',
      empty: '\u8fd8\u6ca1\u6709\u914d\u7f6e\u4efb\u4f55 MCP \u670d\u52a1\u5668\u3002',
      loading: '\u6b63\u5728\u8bfb\u53d6\u2026',
      refresh: '\u5237\u65b0',
      enable: '\u542f\u7528',
      disable: '\u91ca\u653e',
      running: '\u5df2\u6302\u8f7d',
      off: '\u672a\u6302\u8f7d',
      ttlLeft: '\u5269\u4f59',
      ttlDefault: '\u542f\u7528\u540e\u9ed8\u8ba4',
      forever: '\u4e0d\u81ea\u52a8\u91ca\u653e',
      tools: '\u4e2a\u5de5\u5177',
      count: '\u53f0',
      mounted: '\u5df2\u6302\u8f7d',
      error: '\u8bfb\u4e0d\u5230\u670d\u52a1\u5668\u5217\u8868\u3002',
      actionError: '\u8fd9\u6b21\u64cd\u4f5c\u6ca1\u6709\u5b8c\u6210\u3002',
      busy: '\u5904\u7406\u4e2d\u2026',
    }
    const en = {
      'nav.title': 'MCP servers',
      'nav.hint': 'Nothing is mounted until you enable it. Its tools then join the next request, and leave again at the time limit or when you release it.',
      empty: 'No MCP server is configured.',
      loading: 'Loading\u2026',
      refresh: 'Refresh',
      enable: 'Enable',
      disable: 'Release',
      running: 'Mounted',
      off: 'Not mounted',
      ttlLeft: 'Left',
      ttlDefault: 'Default after enable',
      forever: 'No automatic release',
      tools: 'tools',
      count: 'configured',
      mounted: 'mounted',
      error: 'The server list could not be loaded.',
      actionError: 'That action did not finish.',
      busy: 'Working\u2026',
    }

    // The dictionaries above are written with literal backslash-u so this file
    // stays ASCII. Decode them once, the same way a JSON parser would.
    for (const table of [zh, en]) {
      for (const key of Object.keys(table)) {
        table[key] = table[key].replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      }
    }

    function hostFetch(input, init) {
      const carrier = window.__DSH_TRANSPORT__
      return carrier && typeof carrier.fetch === 'function'
        ? carrier.fetch(input, init)
        : fetch(input, init)
    }

    function textOf(locale, key) {
      try {
        if (locale && typeof locale.bind === 'function') return locale.bind(NS)(key)
      } catch { /* the dictionary below still has the string */ }
      return zh[key]
    }

    const DOT = ' ' + String.fromCharCode(0xb7) + ' '

    function clock(seconds) {
      const s = Math.max(0, Math.round(Number(seconds) || 0))
      if (s < 60) return s + 's'
      const minutes = Math.floor(s / 60)
      const rest = s % 60
      return rest === 0 ? minutes + 'm' : minutes + 'm ' + rest + 's'
    }

    function ttlText(server, t) {
      if (server.release === 'off') return t('forever')
      const amount = clock(server.ttl_seconds)
      return (server.release === 'remaining' ? t('ttlLeft') : t('ttlDefault')) + ' ' + amount
    }

    // Registered is not the same as connected. The host reports connecting,
    // failed, and reconnecting on a row that is already in the live map.
    function badgeOf(server, t) {
      if (server.running !== true) return { label: t('off'), tone: 'off' }
      const status = typeof server.status === 'string' ? server.status : ''
      if (status === '' || status === 'connected' || status === 'running') {
        return { label: t('running'), tone: 'on' }
      }
      if (status === 'connecting' || status === 'reconnecting') return { label: status, tone: 'wait' }
      return { label: status, tone: 'bad' }
    }

    const buttonStyle = {
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'transparent',
      color: 'var(--dsw-alias-label-primary)',
      borderRadius: 8,
      padding: '6px 12px',
      cursor: 'pointer',
      font: 'inherit',
    }

    function SettingsPage() {
      const locale = appCtx && appCtx.locale
      const t = (key) => textOf(locale, key)
      const [view, setView] = React.useState({ phase: 'loading', servers: [], error: '' })
      const [busy, setBusy] = React.useState('')
      const [tick, setTick] = React.useState(0)

      React.useEffect(() => {
        if (busy) return undefined
        let on = true
        const pull = async () => {
          try {
            const response = await hostFetch(API, { method: 'GET', credentials: 'same-origin' })
            const value = await response.json()
            if (!on) return
            if (!response.ok || !value || !Array.isArray(value.servers)) {
              setView((current) => ({
                ...current,
                phase: current.servers.length > 0 ? 'ready' : 'error',
                error: t('error'),
              }))
              return
            }
            setView({ phase: 'ready', servers: value.servers, error: '' })
          } catch {
            if (on) {
              setView((current) => ({
                ...current,
                phase: current.servers.length > 0 ? 'ready' : 'error',
                error: t('error'),
              }))
            }
          }
        }
        void pull()
        const timer = setInterval(() => { void pull() }, 4000)
        return () => {
          on = false
          clearInterval(timer)
        }
      }, [busy, tick])

      const act = async (name, action) => {
        if (busy) return
        setBusy(name)
        setView((current) => ({ ...current, error: '' }))
        try {
          const response = await hostFetch(API, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name, action }),
          })
          const value = await response.json()
          if (!response.ok || !Array.isArray(value.servers)) {
            setView((current) => ({ ...current, phase: 'ready', error: t('actionError') }))
            return
          }
          const result = value.result || {}
          const failed = (action === 'enable' && result.running !== true)
            || (action === 'disable' && result.running !== false)
          setView({
            phase: 'ready',
            servers: value.servers,
            error: failed ? (result.note || t('actionError')) : '',
          })
        } catch {
          setView((current) => ({ ...current, phase: 'ready', error: t('actionError') }))
        } finally {
          setBusy('')
        }
      }

      const servers = view.servers
      const mounted = servers.filter((server) => server.running).length
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 720, color: 'var(--dsw-alias-label-primary)' } },
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 } },
          h('p', { style: { margin: 0, fontSize: 13, lineHeight: 1.5, color: 'var(--dsw-alias-label-secondary)' } }, t('nav.hint')),
          h('button', {
            type: 'button',
            onClick: () => setTick((current) => current + 1),
            disabled: busy !== '' || view.phase === 'loading',
            style: { ...buttonStyle, flexShrink: 0, opacity: busy || view.phase === 'loading' ? 0.5 : 1 },
          }, t('refresh')),
        ),
        view.phase === 'loading'
          ? h('p', { style: { margin: 0, color: 'var(--dsw-alias-label-secondary)' } }, t('loading'))
          : null,
        view.error
          ? h('p', { role: 'status', style: { margin: 0, color: 'var(--dsw-alias-state-error-primary)' } }, view.error)
          : null,
        view.phase === 'ready'
          ? h('p', { style: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } },
            servers.length + ' ' + t('count') + DOT + mounted + ' ' + t('mounted'))
          : null,
        view.phase === 'ready' && servers.length === 0
          ? h('p', { style: { margin: 0, color: 'var(--dsw-alias-label-secondary)' } }, t('empty'))
          : null,
        ...servers.map((server) => {
          const on = server.running === true
          const badge = badgeOf(server, t)
          const badgeColor = badge.tone === 'on'
            ? 'var(--dsw-alias-state-success-primary)'
            : badge.tone === 'wait'
              ? 'var(--dsw-alias-state-warn-primary)'
              : badge.tone === 'bad'
                ? 'var(--dsw-alias-state-error-primary)'
                : 'var(--dsw-alias-label-secondary)'
          const toolCount = Array.isArray(server.tools) ? server.tools.length : 0
          return h('section', {
            key: server.name,
            style: {
              background: 'var(--dsw-alias-bg-layer-2)',
              border: '1px solid var(--dsw-alias-border-l1)',
              borderRadius: 10,
              padding: '12px 14px',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            },
          },
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 } },
            h('strong', { style: { fontSize: 15 } }, server.name),
            h('span', {
              style: {
                fontSize: 12,
                padding: '2px 8px',
                borderRadius: 999,
                border: '1px solid ' + (badge.tone === 'off' ? 'var(--dsw-alias-border-l1)' : badgeColor),
                color: badgeColor,
              },
            }, badge.label),
          ),
          h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } },
            [server.transport || '', ttlText(server, t), on ? toolCount + ' ' + t('tools') : ''].filter(Boolean).join(DOT),
          ),
          server.target
            ? h('div', {
              title: server.target,
              style: {
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                fontSize: 12,
                color: 'var(--dsw-alias-label-secondary)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              },
            }, server.target)
            : null,
          h('div', null,
            h('button', {
              type: 'button',
              disabled: busy !== '',
              'aria-busy': busy === server.name,
              onClick: () => { void act(server.name, on ? 'disable' : 'enable') },
              style: { ...buttonStyle, opacity: busy ? 0.5 : 1 },
            }, busy === server.name ? t('busy') : (on ? t('disable') : t('enable'))),
          ),
          )
        }),
      )
    }

    let appCtx = null
    function apply(ctx) {
      appCtx = ctx
      const locale = ctx.locale
      if (locale && typeof locale.register === 'function') {
        ctx.effect(() => locale.register(NS, { zh, en }), 'mcp-on-demand dictionaries')
      }
      if (ctx.slots && typeof ctx.slots.inject === 'function') {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'mcp-on-demand',
          order: 39,
          locale: NS,
          label: () => textOf(ctx.locale, 'nav.title'),
        }, SettingsPage))
      }
      ctx.effect(() => () => { appCtx = null }, 'mcp-on-demand page cleanup')
    }

    return {
      name: 'mcp-on-demand',
      inject: ['slots', 'locale'],
      apply,
    }
  },
})
