/**
 * Settings page for dsh-plugin-mcp-on-demand.
 *
 * Lists every server the plugin can mount, whether it is mounted now, and
 * lets the user enable, probe, or release it. The model uses the same
 * operations; this page calls that same route.
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
      probe: '\u63a2\u6d4b',
      find: '\u641c\u7d22',
      findPlaceholder: '\u6309\u540d\u79f0\u6216\u7528\u9014\u8fc7\u6ee4',
      noMatch: '\u6ca1\u6709\u7b26\u5408\u7684\u670d\u52a1\u5668\u3002',
      catalogReady: '\u5df2\u8bb0\u5f55',
      catalogStale: '\u76ee\u5f55\u5df2\u8fc7\u671f',
      catalogFail: '\u4e0a\u6b21\u63a2\u6d4b\u5931\u8d25',
      connecting: '\u6b63\u5728\u8fde\u63a5',
      reconnecting: '\u6b63\u5728\u91cd\u8fde',
      needsAuth: '\u7b49\u5f85\u51ed\u636e',
      failed: '\u8fde\u63a5\u5931\u8d25',
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
      probe: 'Probe',
      find: 'Search',
      findPlaceholder: 'Filter by name or purpose',
      noMatch: 'No server matches.',
      catalogReady: 'Recorded',
      catalogStale: 'Catalog expired',
      catalogFail: 'Last probe failed',
      connecting: 'Connecting',
      reconnecting: 'Reconnecting',
      needsAuth: 'Waiting for credentials',
      failed: 'Connection failed',
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
      if (server.running !== true) return { label: t('off'), tone: 'off', detail: '' }
      const raw = typeof server.status === 'string' ? server.status : ''
      const splitAt = raw.indexOf(':')
      const state = (splitAt >= 0 ? raw.slice(0, splitAt) : raw).trim()
      const detail = splitAt >= 0 ? raw.slice(splitAt + 1).trim() : ''
      if (state === '' || state === 'connected' || state === 'running') {
        return { label: t('running'), tone: 'on', detail: '' }
      }
      if (state === 'connecting') return { label: t('connecting'), tone: 'wait', detail: '' }
      if (state === 'reconnecting') return { label: t('reconnecting'), tone: 'wait', detail: '' }
      if (state === 'waiting-credentials') return { label: t('needsAuth'), tone: 'wait', detail: '' }
      if (state === 'failed') return { label: t('failed'), tone: 'bad', detail }
      return { label: t('failed'), tone: 'bad', detail: raw }
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
      const [view, setView] = React.useState({ phase: 'loading', servers: [], notice: '', tone: '', fetchedAt: 0 })
      const [busy, setBusy] = React.useState({})
      const [query, setQuery] = React.useState('')
      const [tick, setTick] = React.useState(0)
      const [nowMs, setNowMs] = React.useState(() => Date.now())

      React.useEffect(() => {
        const timer = setInterval(() => setNowMs(Date.now()), 1000)
        return () => clearInterval(timer)
      }, [])

      React.useEffect(() => {
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
                notice: current.servers.length > 0 ? current.notice : t('error'),
                tone: current.servers.length > 0 ? current.tone : 'bad',
              }))
              return
            }
            setView((current) => ({
              phase: 'ready',
              servers: value.servers,
              notice: current.notice,
              tone: current.tone,
              fetchedAt: Date.now(),
            }))
          } catch {
            if (on) {
              setView((current) => ({
                ...current,
                phase: current.servers.length > 0 ? 'ready' : 'error',
                notice: current.servers.length > 0 ? current.notice : t('error'),
                tone: current.servers.length > 0 ? current.tone : 'bad',
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
      }, [tick])

      const act = async (name, action) => {
        if (busy[name]) return
        setBusy((current) => ({ ...current, [name]: action }))
        setView((current) => ({ ...current, notice: '', tone: '' }))
        try {
          const response = await hostFetch(API, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name, action }),
          })
          const value = await response.json()
          if (!response.ok || !Array.isArray(value.servers)) {
            setView((current) => ({ ...current, phase: 'ready', notice: t('actionError'), tone: 'bad' }))
            return
          }
          const result = value.result || {}
          const failed = (action === 'enable' && result.running !== true)
            || (action === 'disable' && result.running !== false)
            || (action === 'probe' && result.ok !== true)
          const names = Array.isArray(result.tools) ? result.tools.slice(0, 8).join(', ') : ''
          setView({
            phase: 'ready',
            servers: value.servers,
            fetchedAt: Date.now(),
            notice: failed ? (result.note || t('actionError')) : (action === 'probe' ? names : ''),
            tone: failed ? 'bad' : 'ok',
          })
        } catch {
          setView((current) => ({ ...current, phase: 'ready', notice: t('actionError'), tone: 'bad' }))
        } finally {
          setBusy((current) => {
            const next = { ...current }
            delete next[name]
            return next
          })
        }
      }

      const elapsed = view.fetchedAt ? Math.max(0, Math.round((nowMs - view.fetchedAt) / 1000)) : 0
      const needle = query.trim().toLowerCase()
      const servers = needle === ''
        ? view.servers
        : view.servers.filter((server) => {
          const catalog = server.catalog && typeof server.catalog === 'object' ? server.catalog : {}
          const sample = Array.isArray(catalog.sample) ? catalog.sample.join(' ') : ''
          return [server.name, server.description, server.target, sample].join(' ').toLowerCase().includes(needle)
        })
      const mounted = servers.filter((server) => server.running).length
      const countText = needle && servers.length !== view.servers.length
        ? servers.length + ' / ' + view.servers.length
        : String(servers.length)
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 720, color: 'var(--dsw-alias-label-primary)' } },
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 } },
          h('p', { style: { margin: 0, fontSize: 13, lineHeight: 1.5, color: 'var(--dsw-alias-label-secondary)' } }, t('nav.hint')),
          h('div', { style: { display: 'flex', gap: 8, flexShrink: 0 } },
            h('input', {
              type: 'search',
              value: query,
              placeholder: t('findPlaceholder'),
              'aria-label': t('find'),
              onChange: (event) => setQuery(event.target.value),
              style: {
                ...buttonStyle,
                width: 180,
                padding: '6px 10px',
              },
            }),
            h('button', {
              type: 'button',
              onClick: () => setTick((current) => current + 1),
              disabled: view.phase === 'loading',
              style: { ...buttonStyle, opacity: view.phase === 'loading' ? 0.5 : 1 },
            }, t('refresh')),
          ),
        ),
        view.phase === 'loading'
          ? h('p', { style: { margin: 0, color: 'var(--dsw-alias-label-secondary)' } }, t('loading'))
          : null,
        view.notice
          ? h('p', {
            role: 'status',
            style: {
              margin: 0,
              color: view.tone === 'bad'
                ? 'var(--dsw-alias-state-error-primary)'
                : 'var(--dsw-alias-label-secondary)',
            },
          }, view.notice)
          : null,
        view.phase === 'ready'
          ? h('p', { style: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } },
            countText + ' ' + t('count') + DOT + mounted + ' ' + t('mounted'))
          : null,
        view.phase === 'ready' && servers.length === 0
          ? h('p', { style: { margin: 0, color: 'var(--dsw-alias-label-secondary)' } }, needle ? t('noMatch') : t('empty'))
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
          const catalog = server.catalog && typeof server.catalog === 'object' ? server.catalog : null
          const sample = catalog && Array.isArray(catalog.sample) ? catalog.sample.filter(Boolean).join(', ') : ''
          const shown = {
            ...server,
            ttl_seconds: server.release === 'remaining'
              ? Math.max(0, (Number(server.ttl_seconds) || 0) - elapsed)
              : server.ttl_seconds,
          }
          const catalogText = on || !catalog
            ? ''
            : catalog.ok === true && catalog.stale !== true
              ? t('catalogReady') + ' ' + (catalog.toolCount || 0)
              : catalog.stale === true
                ? t('catalogStale')
                : catalog.ok === false
                  ? t('catalogFail')
                  : ''
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
            [server.transport || '', ttlText(shown, t), on ? toolCount + ' ' + t('tools') : catalogText].filter(Boolean).join(DOT),
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
          server.description
            ? h('div', { style: { fontSize: 13, lineHeight: 1.45 } }, server.description)
            : null,
          badge.detail || (!on && catalog && catalog.ok === false && catalog.error)
            ? h('div', {
              title: badge.detail || catalog.error,
              style: {
                fontSize: 12,
                color: 'var(--dsw-alias-state-error-primary)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              },
            }, badge.detail || catalog.error)
            : null,
          sample && !on
            ? h('div', {
              title: sample,
              style: {
                fontSize: 12,
                color: 'var(--dsw-alias-label-secondary)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              },
            }, sample)
            : null,
          h('div', { style: { display: 'flex', gap: 8 } },
            h('button', {
              type: 'button',
              disabled: Boolean(busy[server.name]),
              'aria-busy': busy[server.name] === 'enable' || busy[server.name] === 'disable',
              onClick: () => { void act(server.name, on ? 'disable' : 'enable') },
              style: { ...buttonStyle, opacity: busy[server.name] ? 0.5 : 1 },
            }, busy[server.name] === 'enable' || busy[server.name] === 'disable' ? t('busy') : (on ? t('disable') : t('enable'))),
            on ? null : h('button', {
              type: 'button',
              disabled: Boolean(busy[server.name]),
              'aria-busy': busy[server.name] === 'probe',
              onClick: () => { void act(server.name, 'probe') },
              style: { ...buttonStyle, opacity: busy[server.name] ? 0.5 : 1 },
            }, busy[server.name] === 'probe' ? t('busy') : t('probe')),
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
