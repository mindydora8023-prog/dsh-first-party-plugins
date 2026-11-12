window.__ModuleLoader__.load({
  id: 'dsh-plugin-archived-sessions',
  factory: (require) => {
    const React = require('react'), h = React.createElement
    const NS = 'archivedSessions'
    const zh = { nav: '\u5df2\u5f52\u6863\u4f1a\u8bdd', hint: '\u6062\u590d\u540e\uff0c\u4f1a\u8bdd\u56de\u5230\u4fa7\u680f\u539f\u4f4d\u7f6e\uff1b\u4e0d\u4f1a\u81ea\u52a8\u7ee7\u7eed\u5df2\u505c\u6b62\u7684\u4efb\u52a1\u3002', search: '\u641c\u7d22\u6807\u9898\u3001\u4f1a\u8bdd ID \u6216\u5de5\u4f5c\u76ee\u5f55', empty: '\u6682\u65e0\u5df2\u5f52\u6863\u4f1a\u8bdd', loading: '\u6b63\u5728\u52a0\u8f7d\u4f1a\u8bdd\u2026', restore: '\u6062\u590d', delete: '\u5220\u9664', confirm: '\u786e\u8ba4\u5220\u9664', cancel: '\u53d6\u6d88', busy: '\u5904\u7406\u4e2d\u2026', untitled: '\u672a\u547d\u540d\u4f1a\u8bdd', warning: '\u6c38\u4e45\u5220\u9664\u6b64\u4f1a\u8bdd\u7684\u65e5\u5fd7\uff0c\u65e0\u6cd5\u64a4\u9500\u3002\u82e5\u4f1a\u8bdd\u4ecd\u88ab\u5bbf\u4e3b\u5360\u7528\u6216\u5b58\u5728\u5b50\u4f1a\u8bdd\uff0c\u5220\u9664\u4f1a\u88ab\u62d2\u7edd\u3002', restored: '\u4f1a\u8bdd\u5df2\u6062\u590d\uff0c\u53ef\u5728\u4fa7\u680f\u6253\u5f00\u3002', deleted: '\u4f1a\u8bdd\u5df2\u5220\u9664\u3002', failed: '\u64cd\u4f5c\u5931\u8d25\uff0c\u8bf7\u5237\u65b0\u540e\u91cd\u8bd5\u3002', retry: '\u5237\u65b0', loadFailed: '\u4f1a\u8bdd\u5217\u8868\u52a0\u8f7d\u5931\u8d25\uff0c\u8bf7\u68c0\u67e5\u8fde\u63a5\u540e\u5237\u65b0\u3002' }
    const en = { nav: 'Archived sessions', hint: 'Restored sessions return to their sidebar position. Stopped work does not resume automatically.', search: 'Search title, session ID or working directory', empty: 'No archived sessions', loading: 'Loading sessions\u2026', restore: 'Restore', delete: 'Delete', confirm: 'Confirm deletion', cancel: 'Cancel', busy: 'Working\u2026', untitled: 'Untitled session', warning: 'Permanently delete this session\u2019s logs? This cannot be undone. Sessions still held by the host or referenced by descendants cannot be deleted.', restored: 'Session restored. Open it from the sidebar.', deleted: 'Session deleted.', failed: 'Operation failed. Refresh and try again.', retry: 'Refresh', loadFailed: 'Failed to load sessions. Check the connection and refresh.' }
    Object.assign(zh, { select: '\u9009\u62e9\u4f1a\u8bdd', selectAll: '\u5168\u9009\u5f53\u524d\u7ed3\u679c', clear: '\u6e05\u7a7a\u9009\u62e9', selected: '\u5df2\u9009', restoreSelected: '\u6062\u590d\u9009\u4e2d', deleteSelected: '\u5220\u9664\u9009\u4e2d', batchWarning: '\u786e\u8ba4\u6c38\u4e45\u5220\u9664\u9009\u4e2d\u7684\u4f1a\u8bdd\uff1f\u6b64\u64cd\u4f5c\u65e0\u6cd5\u64a4\u9500\u3002', succeeded: '\u6210\u529f', failures: '\u5931\u8d25', withChildren: '\u5c06\u540c\u65f6\u5220\u9664\u8fd9\u4e9b\u9690\u85cf\u5b50 Agent\uff08\u4f1a\u8bdd\u8bb0\u5f55\u4e0d\u4f1a\u51fa\u73b0\u5728\u5f52\u6863\u5217\u8868\u91cc\uff09', ghost: '\u78c1\u76d8\u4e0a\u5df2\u6ca1\u6709\u65e5\u5fd7\uff0c\u4ec5\u6e05\u7406\u6b8b\u7559\u7684\u5f52\u6863\u8bb0\u5f55', blocked: '\u4ee5\u4e0b\u5b50\u4f1a\u8bdd\u4e0d\u80fd\u8fde\u5e26\u5220\u9664\uff0c\u8bf7\u5148\u5355\u72ec\u5904\u7406', childrenCount: '\u9690\u85cf\u5b50 Agent', ghostCount: '\u6b8b\u7559\u8bb0\u5f55', cleanup: '\u4e00\u5e76\u6e05\u7406', checking: '\u6b63\u5728\u68c0\u67e5\u53ef\u5220\u9664\u5185\u5bb9\u2026', orphanTitle: '\u5b64\u513f\u5b50 Agent', orphanHint: '\u8fd9\u4e9b\u5b50 Agent \u7684\u7236\u4f1a\u8bdd\u65e5\u5fd7\u5df2\u7ecf\u4e0d\u5b58\u5728\uff0c\u5b83\u4eec\u4e0d\u5728\u4efb\u4f55\u5217\u8868\u91cc\uff0c\u53ea\u80fd\u5728\u8fd9\u91cc\u6e05\u7406\u3002', orphanScan: '\u626b\u63cf\u5b64\u513f\u4f1a\u8bdd', orphanEmpty: '\u6ca1\u6709\u5b64\u513f\u5b50 Agent\u3002', orphanBlocked: '\u4ee5\u4e0b\u5b64\u513f\u4f1a\u8bdd\u4e0d\u80fd\u6e05\u7406', orphanDelete: '\u6e05\u7406\u5168\u90e8\u5b64\u513f', orphanConfirm: '\u786e\u8ba4\u6e05\u7406\u8fd9\u4e9b\u5b64\u513f\u5b50 Agent \u7684\u65e5\u5fd7\uff1f\u6b64\u64cd\u4f5c\u65e0\u6cd5\u64a4\u9500\u3002', orphanDone: '\u5df2\u6e05\u7406\u5b64\u513f\u5b50 Agent', orphanCount: '\u5b64\u513f\u4f1a\u8bdd' })
    Object.assign(en, { select: 'Select session', selectAll: 'Select all results', clear: 'Clear selection', selected: 'Selected', restoreSelected: 'Restore selected', deleteSelected: 'Delete selected', batchWarning: 'Permanently delete the selected sessions? This cannot be undone.', succeeded: 'Succeeded', failures: 'Failed', withChildren: 'These hidden subagent sessions will be deleted too:', ghost: 'No log remains on disk; only the stale archive record is removed', blocked: 'These descendants cannot be removed with the parent; handle them first', childrenCount: 'hidden subagents', ghostCount: 'stale records', cleanup: 'Delete together', checking: 'Checking what can be deleted\u2026', orphanTitle: 'Orphaned subagents', orphanHint: 'The parent session log of these subagents is gone. They appear in no list, so this is the only place they can be cleaned up.', orphanScan: 'Scan for orphans', orphanEmpty: 'No orphaned subagents.', orphanBlocked: 'These orphaned sessions cannot be cleaned up', orphanDelete: 'Clean up all orphans', orphanConfirm: 'Permanently delete the logs of these orphaned subagents? This cannot be undone.', orphanDone: 'Orphaned subagents removed', orphanCount: 'orphaned sessions' })
    Object.assign(zh, { cleanupTitle: "\u81ea\u52a8\u6e05\u7406", cleanupHint: "\u5df2\u5f52\u6863\u4f1a\u8bdd\u5728\u6700\u540e\u6d3b\u52a8\u8d85\u8fc7\u8bbe\u5b9a\u5929\u6570\u540e\u4f1a\u88ab\u81ea\u52a8\u6c38\u4e45\u5220\u9664\uff0c\u9690\u85cf\u5b50 Agent \u4f1a\u4e00\u5e76\u6e05\u7406\uff1b\u88ab\u5bbf\u4e3b\u5360\u7528\u6216\u88ab\u5f15\u7528\u7684\u4f1a\u8bdd\u4f1a\u8df3\u8fc7\u3002", cleanupEnabled: "\u542f\u7528\u81ea\u52a8\u6e05\u7406", cleanupDays: "\u4fdd\u7559\u5929\u6570", cleanupSave: "\u4fdd\u5b58\u8bbe\u7f6e", cleanupSaved: "\u81ea\u52a8\u6e05\u7406\u8bbe\u7f6e\u5df2\u4fdd\u5b58\u3002", cleanupNow: "\u7acb\u5373\u6e05\u7406", cleanupConfirm: "\u786e\u8ba4\u7acb\u5373\u6e05\u7406\u6240\u6709\u8d85\u671f\u7684\u5df2\u5f52\u6863\u4f1a\u8bdd\uff1f\u6b64\u64cd\u4f5c\u65e0\u6cd5\u64a4\u9500\u3002", cleanupRunning: "\u6b63\u5728\u6e05\u7406\u2026", cleanupLast: "\u4e0a\u6b21\u6e05\u7406", cleanupNever: "\u5c1a\u672a\u8fd0\u884c", cleanupDone: "\u6e05\u7406\u5b8c\u6210", cleanupDeletedLabel: "\u5df2\u5220\u9664", cleanupScannedLabel: "\u626b\u63cf", cleanupBlockedLabel: "\u8df3\u8fc7", cleanupErrorsLabel: "\u5931\u8d25", cleanupDaysInvalid: "\u4fdd\u7559\u5929\u6570\u9700\u4e3a 1 \u5230 3650 \u7684\u6574\u6570\u3002", cleanupOff: "\u81ea\u52a8\u6e05\u7406\u5df2\u5173\u95ed" })
    Object.assign(en, { cleanupTitle: 'Automatic cleanup', cleanupHint: 'Archived sessions whose last activity is older than the threshold are permanently deleted automatically, together with their hidden sub-agents. Sessions still held or referenced by the host are skipped.', cleanupEnabled: 'Enable automatic cleanup', cleanupDays: 'Keep days', cleanupSave: 'Save settings', cleanupSaved: 'Automatic cleanup settings saved.', cleanupNow: 'Clean up now', cleanupConfirm: 'Permanently clean up every expired archived session now? This cannot be undone.', cleanupRunning: 'Cleaning up\u2026', cleanupLast: 'Last cleanup', cleanupNever: 'Not run yet', cleanupDone: 'Cleanup finished', cleanupDeletedLabel: 'deleted', cleanupScannedLabel: 'scanned', cleanupBlockedLabel: 'skipped', cleanupErrorsLabel: 'failed', cleanupDaysInvalid: 'Keep days must be an integer from 1 to 3650.', cleanupOff: 'Automatic cleanup is off' })
    const button = { border: '1px solid var(--dsw-alias-border-primary, #8884)', background: 'transparent', color: 'inherit', borderRadius: 7, padding: '6px 12px', cursor: 'pointer', flexShrink: 0 }
    const inspectTargets = async ids => {
      const res = await fetch('/archived-sessions/manage', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-archived-sessions-action': 'manage' }, body: JSON.stringify({ action: 'inspect', sessionIds: ids }) })
      const result = await res.json()
      if (!res.ok || !result.ok) throw Error(result.error ?? 'inspect failed')
      const items = result.items ?? []
      return { ids, items, children: items.flatMap(item => item.children ?? []), ghosts: items.filter(item => item.archived && !item.hasLog).map(item => item.id), blocked: items.flatMap(item => item.blocked ?? []), stuck: items.filter(item => (item.blocked ?? []).length > 0).map(item => item.id) }
    }
    const orphans = async body => {
      const res = await fetch('/archived-sessions/manage', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-archived-sessions-action': 'manage' }, body: JSON.stringify(body) })
      const result = await res.json()
      if (!res.ok || !result.ok) throw Error(result.error ?? 'operation failed')
      return result
    }
    function Page({ ctx, t }) {
      const sessions = ctx.sessions, workspaces = ctx.workspaces
      // Host store methods rely on their receiver; never pass unbound prototype methods to React.
      const sessionStore = React.useMemo(() => ({ subscribe: callback => sessions.list.subscribe(callback), snapshot: () => sessions.list.getSnapshot() }), [sessions])
      const workspaceStore = React.useMemo(() => ({ subscribe: callback => workspaces.list.subscribe(callback), snapshot: () => workspaces.list.getSnapshot() }), [workspaces])
      const list = React.useSyncExternalStore(sessionStore.subscribe, sessionStore.snapshot, sessionStore.snapshot)
      const ws = React.useSyncExternalStore(workspaceStore.subscribe, workspaceStore.snapshot, workspaceStore.snapshot)
      const [query, setQuery] = React.useState(''), [pending, setPending] = React.useState(null), [confirm, setConfirm] = React.useState(null), [notice, setNotice] = React.useState(null)
      const [selection, setSelection] = React.useState([]), [batchConfirm, setBatchConfirm] = React.useState(null), [plan, setPlan] = React.useState(null), [orphanView, setOrphanView] = React.useState(null)
      const [cleanup, setCleanup] = React.useState(null), [cleanupForm, setCleanupForm] = React.useState({ enabled: true, days: 5 }), [cleanupPending, setCleanupPending] = React.useState(false), [cleanupConfirm, setCleanupConfirm] = React.useState(false)
      const lock = React.useRef(false), alive = React.useRef(true)
      // Orphans are invisible everywhere else, so surface them on open instead of behind a click.
      React.useEffect(() => {
        alive.current = true
        orphans({ action: 'orphans' })
          .then(result => { if (alive.current) setOrphanView({ orphans: result.orphans ?? [], blocked: result.blocked ?? [] }) })
          .catch(() => {})
        orphans({ action: 'cleanupStatus' })
          .then(result => { if (alive.current && result.cleanup) { setCleanup(result.cleanup); setCleanupForm({ enabled: result.cleanup.enabled !== false, days: Number(result.cleanup.days) || 5 }) } })
          .catch(() => {})
        return () => { alive.current = false }
      }, [])
      const ids = ws.archivedSessionIds ?? []
      const rows = ids.map(id => list.byId[id] ?? { id }).filter(row => `${row.title ?? ''} ${row.id} ${row.cwd ?? ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())).sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0))
      const refresh = async () => { try { await sessions.refresh() } catch { if (alive.current) setNotice({ error: true, text: t('loadFailed') }) } }
      const selected = selection.filter(id => ids.includes(id))
      const toggle = id => { setBatchConfirm(null); setPlan(null); setSelection(current => current.includes(id) ? current.filter(value => value !== id) : [...current, id]) }
      const check = async targets => {
        setPlan({ ids: targets, loading: true })
        try { const next = await inspectTargets(targets); if (alive.current) setPlan(next) }
        catch (error) { if (alive.current) { setPlan(null); setNotice({ error: true, text: error.message ?? t('failed') }) } }
      }
      const perform = async (id, action, options = {}) => {
        if (action === 'restore') { await workspaces.unarchiveSession(id); return { ok: true } }
        const body = { sessionId: id, action }
        if (options.cascade) body.cascade = true
        if (Array.isArray(options.children)) body.children = options.children
        const res = await fetch('/archived-sessions/manage', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-archived-sessions-action': 'manage' }, body: JSON.stringify(body) })
        const result = await res.json()
        if (!res.ok || !result.ok) throw Error(result.error ?? t('failed'))
        return result
      }
      // Only the descendants listed in the confirmation may be deleted: derive them per parent
      // from the preflight items rather than trusting one flat list.
      const childrenOf = (id, fallback) => Array.isArray(fallback) ? fallback : plan?.items?.find(item => item.id === id)?.children ?? []
      const batch = async (targets, action) => {
        if (lock.current || !targets.length) return
        lock.current = true; setPending('batch'); setNotice(null); setConfirm(null); setBatchConfirm(null)
        const successes = [], failures = [], warnings = []
        let removed = 0
        try {
          for (const id of targets) {
            try { const result = await perform(id, action, { cascade: action === 'delete', children: action === 'delete' ? childrenOf(id) : undefined }); successes.push(id); removed += result.children ?? 0; if (result.warning) warnings.push(`${id}: ${result.warning}`) }
            catch (error) { failures.push(`${id}: ${error.message ?? t('failed')}`) }
          }
          if (alive.current) {
            setSelection(current => current.filter(id => !successes.includes(id)))
            setNotice({ error: !!(failures.length || warnings.length), text: `${t('succeeded')}: ${successes.length} \u00b7 ${t('failures')}: ${failures.length}${removed ? ` \u00b7 ${t('childrenCount')}: ${removed}` : ''}${[...failures, ...warnings].length ? '\n' + [...failures, ...warnings].join('\n') : ''}` })
          }
          await refresh()
        } finally { lock.current = false; if (alive.current) setPending(null) }
      }
      const act = async (id, action) => {
        if (lock.current) return
        lock.current = true; setPending(id); setNotice(null)
        try {
          const result = await perform(id, action, { cascade: action === 'delete', children: action === 'delete' ? childrenOf(id) : undefined })
          if (result.warning) { await refresh(); throw Error(result.warning) }
          if (alive.current) setSelection(current => current.filter(value => value !== id))
          if (alive.current) { setConfirm(null); setPlan(null); setNotice({ error: false, text: t(action === 'restore' ? 'restored' : 'deleted') + (result.children ? ` \u00b7 ${t('childrenCount')}: ${result.children}` : '') }) }
          await refresh()
        } catch (error) { if (alive.current) setNotice({ error: true, text: error.message ?? t('failed') }) }
        finally { lock.current = false; if (alive.current) setPending(null) }
      }
      const loading = list.phase === 'pending' || ws.phase === 'pending'
      const scanOrphans = async () => {
        setOrphanView({ loading: true })
        try { const result = await orphans({ action: 'orphans' }); if (alive.current) setOrphanView({ orphans: result.orphans ?? [], blocked: result.blocked ?? [] }) }
        catch (error) { if (alive.current) { setOrphanView(null); setNotice({ error: true, text: error.message ?? t('failed') }) } }
      }
      const clearOrphans = async (targets, confirmed) => {
        if (lock.current || !targets.length) return
        if (!confirmed) { if (alive.current) setOrphanView(view => ({ ...view, confirm: targets })); return }
        lock.current = true; setPending('orphans'); setNotice(null)
        try {
          const result = await orphans({ action: 'deleteOrphans', sessionIds: targets })
          if (alive.current) { setOrphanView(null); setNotice({ error: false, text: `${t('orphanDone')}: ${result.removed ?? targets.length}${result.warning ? '\n' + result.warning : ''}` }) }
          await refresh()
          if (alive.current) await scanOrphans()
        } catch (error) { if (alive.current) setNotice({ error: true, text: error.message ?? t('failed') }) }
        finally { lock.current = false; if (alive.current) setPending(null) }
      }
      const saveCleanup = async () => {
        if (cleanupPending) return
        const days = Number(cleanupForm.days)
        if (!Number.isInteger(days) || days < 1 || days > 3650) { if (alive.current) setNotice({ error: true, text: t('cleanupDaysInvalid') }); return }
        setCleanupPending(true); setNotice(null)
        try {
          const result = await orphans({ action: 'setCleanup', enabled: !!cleanupForm.enabled, days })
          if (alive.current && result.cleanup) { setCleanup(current => ({ ...(current ?? {}), ...result.cleanup })); setCleanupForm({ enabled: result.cleanup.enabled !== false, days: Number(result.cleanup.days) || days }); setNotice({ error: false, text: t('cleanupSaved') }) }
        } catch (error) { if (alive.current) setNotice({ error: true, text: error.message ?? t('failed') }) }
        finally { if (alive.current) setCleanupPending(false) }
      }
      const runCleanup = async () => {
        if (cleanupPending) return
        setCleanupPending(true); setNotice(null); setCleanupConfirm(false)
        try {
          const result = await orphans({ action: 'runCleanup' })
          const report = result.report ?? {}
          if (alive.current) {
            setCleanup(current => ({ enabled: cleanupForm.enabled, days: Number(cleanupForm.days) || 5, ...(current ?? {}), lastRun: report }))
            const parts = [`${t('cleanupScannedLabel')}: ${report.scanned ?? 0}`, `${t('cleanupDeletedLabel')}: ${report.deleted ?? 0}`]
            if (report.children) parts.push(`${t('childrenCount')}: ${report.children}`)
            if (report.blocked) parts.push(`${t('cleanupBlockedLabel')}: ${report.blocked}`)
            if (report.errors) parts.push(`${t('cleanupErrorsLabel')}: ${report.errors}`)
            setNotice({ error: !!report.errors, text: `${t('cleanupDone')} \u00b7 ${parts.join(' \u00b7 ')}` })
          }
          await refresh()
        } catch (error) { if (alive.current) setNotice({ error: true, text: error.message ?? t('failed') }) }
        finally { if (alive.current) setCleanupPending(false) }
      }
      const planBlocked = plan?.blocked?.length > 0
      const detail = plan && !plan.loading ? plan : null
      const confirmBox = (targets, batchDelete) => h('div', { style: { marginTop: 12, padding: 12, borderRadius: 8, background: 'var(--dsw-alias-interactive-bg-hover, #8881)' } },
        h('p', { style: { margin: '0 0 8px', lineHeight: 1.6 } }, batchDelete ? `${t('batchWarning')} (${targets.length})` : t('warning')),
        plan?.loading && h('p', { role: 'status', style: { margin: '0 0 8px', opacity: .75 } }, t('checking')),
        detail && h('div', { style: { margin: '0 0 12px', fontSize: 13, lineHeight: 1.6 } },
          detail.children.length > 0 && h('div', null, `${t('withChildren')} (${detail.children.length}):`, h('ul', { style: { margin: '6px 0 0', paddingLeft: 20, fontFamily: 'monospace', fontSize: 12 } }, detail.children.map(id => h('li', { key: id, style: { overflowWrap: 'anywhere' } }, id)))),
          detail.ghosts.length > 0 && h('div', null, h('strong', null, t('ghost')), h('ul', { style: { margin: '6px 0 0', paddingLeft: 20, fontFamily: 'monospace', fontSize: 12 } }, detail.ghosts.map(id => h('li', { key: id, style: { overflowWrap: 'anywhere' } }, id)))),
          detail.blocked.length > 0 && h('div', { role: 'alert', style: { color: 'var(--dsw-alias-status-error, #d9534f)' } }, h('strong', null, t('blocked')), h('ul', { style: { margin: '6px 0 0', paddingLeft: 20, fontFamily: 'monospace', fontSize: 12 } }, detail.blocked.map(item => h('li', { key: item.id, style: { overflowWrap: 'anywhere' } }, `${item.id}: ${item.reason}`))))),
        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
          h('button', { type: 'button', style: { ...button, color: '#d9534f' }, disabled: !!pending || !!plan?.loading || (!batchDelete && planBlocked), onClick: () => batchDelete ? batch(targets.filter(id => ids.includes(id)), 'delete') : act(targets[0], 'delete') }, pending ? t('busy') : (detail?.children?.length ? t('cleanup') : t('confirm'))),
          h('button', { type: 'button', style: button, disabled: !!pending, onClick: () => { setConfirm(null); setBatchConfirm(null); setPlan(null) } }, t('cancel'))))
      const orphanPanel = h('div', { style: { marginTop: 24, paddingTop: 16, borderTop: '1px solid var(--dsw-alias-border-primary, #8883)' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h('h3', { style: { fontSize: 15, margin: 0 } }, t('orphanTitle')),
          h('button', { type: 'button', style: button, disabled: !!pending || !!orphanView?.loading, onClick: scanOrphans }, orphanView?.loading ? t('busy') : t('orphanScan'))),
        orphanView && !orphanView.loading && h('div', { style: { marginTop: 10, fontSize: 13, lineHeight: 1.6 } },
          orphanView.orphans?.length === 0 && orphanView.blocked?.length === 0 && h('p', { style: { opacity: .75, margin: 0 } }, t('orphanEmpty')),
          orphanView.orphans?.length > 0 && h('div', null,
            h('p', { style: { margin: '0 0 8px' } }, t('orphanHint')),
            h('ul', { style: { margin: '0 0 12px', paddingLeft: 20, fontFamily: 'monospace', fontSize: 12 } }, orphanView.orphans.map(item => h('li', { key: item.id, style: { overflowWrap: 'anywhere' } }, `${item.id} \u2190 ${item.missingParent}`))),
            orphanView.confirm
              ? h('div', { style: { padding: 12, borderRadius: 8, background: 'var(--dsw-alias-interactive-bg-hover, #8881)' } },
                h('p', { style: { margin: '0 0 10px' } }, `${t('orphanConfirm')} (${orphanView.confirm.length})`),
                h('div', { style: { display: 'flex', gap: 8 } },
                  h('button', { type: 'button', style: { ...button, color: '#d9534f' }, disabled: !!pending, onClick: () => clearOrphans(orphanView.confirm, true) }, pending === 'orphans' ? t('busy') : t('confirm')),
                  h('button', { type: 'button', style: button, disabled: !!pending, onClick: () => setOrphanView(view => ({ ...view, confirm: null })) }, t('cancel'))))
              : h('button', { type: 'button', style: { ...button, color: '#d9534f' }, disabled: !!pending, onClick: () => clearOrphans(orphanView.orphans.map(item => item.id), false) }, `${t('orphanDelete')} (${orphanView.orphans.length})`)),
          orphanView.blocked?.length > 0 && h('div', { role: 'alert', style: { color: 'var(--dsw-alias-status-error, #d9534f)', marginTop: 8 } },
            h('strong', null, t('orphanBlocked')),
            h('ul', { style: { margin: '6px 0 0', paddingLeft: 20, fontFamily: 'monospace', fontSize: 12 } }, orphanView.blocked.map(item => h('li', { key: item.id, style: { overflowWrap: 'anywhere' } }, `${item.id}\uff08${item.missingParent}\uff09: ${item.reason}`)))))
      )
      const lastRun = cleanup?.lastRun
      const lastText = lastRun
        ? `${new Date(lastRun.at).toLocaleString()} \u00b7 ${t('cleanupScannedLabel')} ${lastRun.scanned ?? 0} \u00b7 ${t('cleanupDeletedLabel')} ${lastRun.deleted ?? 0}${lastRun.children ? ` \u00b7 ${t('childrenCount')} ${lastRun.children}` : ''}`
        : t('cleanupNever')
      const cleanupPanel = h('div', { style: { marginTop: 24, paddingTop: 16, borderTop: '1px solid var(--dsw-alias-border-primary, #8883)' } },
        h('h3', { style: { fontSize: 15, margin: 0 } }, t('cleanupTitle')),
        h('p', { style: { color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.6, margin: '8px 0' } }, t('cleanupHint')),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 } },
          h('label', { style: { display: 'flex', alignItems: 'center', gap: 6 } }, h('input', { type: 'checkbox', 'aria-label': t('cleanupEnabled'), checked: !!cleanupForm.enabled, disabled: cleanupPending, onChange: e => setCleanupForm(form => ({ ...form, enabled: e.target.checked })) }), t('cleanupEnabled')),
          h('label', { style: { display: 'flex', alignItems: 'center', gap: 6 } }, t('cleanupDays'), h('input', { type: 'number', 'aria-label': t('cleanupDays'), min: 1, max: 3650, value: cleanupForm.days, disabled: cleanupPending, style: { ...button, width: 84, cursor: 'text' }, onChange: e => setCleanupForm(form => ({ ...form, days: e.target.value })) })),
          h('button', { type: 'button', style: button, disabled: cleanupPending, onClick: saveCleanup }, t('cleanupSave'))),
        h('div', { style: { marginTop: 12, fontSize: 13, lineHeight: 1.6 } },
          h('div', { style: { opacity: .7 } }, `${t('cleanupLast')}: ${lastText}`),
          !cleanup?.enabled && h('div', { style: { opacity: .7, marginTop: 4 } }, t('cleanupOff'))),
        cleanupConfirm
          ? h('div', { style: { marginTop: 12, padding: 12, borderRadius: 8, background: 'var(--dsw-alias-interactive-bg-hover, #8881)' } },
            h('p', { style: { margin: '0 0 10px', lineHeight: 1.6 } }, t('cleanupConfirm')),
            h('div', { style: { display: 'flex', gap: 8 } },
              h('button', { type: 'button', style: { ...button, color: '#d9534f' }, disabled: cleanupPending, onClick: runCleanup }, cleanupPending ? t('cleanupRunning') : t('confirm')),
              h('button', { type: 'button', style: button, disabled: cleanupPending, onClick: () => setCleanupConfirm(false) }, t('cancel'))))
          : h('button', { type: 'button', style: { ...button, color: '#d9534f', marginTop: 12 }, disabled: cleanupPending, onClick: () => setCleanupConfirm(true) }, cleanupPending ? t('cleanupRunning') : t('cleanupNow'))
      )
      return h('section', { style: { padding: '12px 0', color: 'var(--dsw-alias-label-primary)', fontSize: 14, minWidth: 0 } },
        h('h2', { style: { fontSize: 20, margin: '0 0 10px' } }, `${t('nav')} (${ids.length})`),
        h('p', { style: { color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.6 } }, t('hint')),
        cleanupPanel,
        h('div', { style: { display: 'flex', gap: 8, margin: '16px 0' } }, h('input', { type: 'search', 'aria-label': t('search'), placeholder: t('search'), value: query, onChange: e => setQuery(e.target.value), style: { ...button, cursor: 'text', flex: 1, minWidth: 0 } }), h('button', { type: 'button', style: button, disabled: !!pending, onClick: refresh }, t('retry'))),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 12 } },
          h('label', { style: { display: 'flex', alignItems: 'center', gap: 6 } }, h('input', { type: 'checkbox', disabled: !!pending || !rows.length, checked: !!rows.length && rows.every(row => selected.includes(row.id)), onChange: e => { setBatchConfirm(null); setPlan(null); setSelection(current => e.target.checked ? [...new Set([...current, ...rows.map(row => row.id)])] : current.filter(id => !rows.some(row => row.id === id))) } }), t('selectAll')),
          h('span', null, `${t('selected')}: ${selected.length}`),
          h('button', { type: 'button', style: button, disabled: !!pending || !selected.length, onClick: () => { setSelection([]); setBatchConfirm(null); setPlan(null) } }, t('clear')),
          h('button', { type: 'button', style: button, disabled: !!pending || !selected.length, onClick: () => batch([...selected], 'restore') }, t('restoreSelected')),
          h('button', { type: 'button', style: { ...button, color: '#d9534f' }, disabled: !!pending || !selected.length, onClick: () => { setConfirm(null); setBatchConfirm([...selected]); return check([...selected]) } }, t('deleteSelected'))),
        batchConfirm && confirmBox(batchConfirm, true),
        notice && h('p', { role: notice.error ? 'alert' : 'status', style: { lineHeight: 1.5, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: notice.error ? 'var(--dsw-alias-status-error, #d9534f)' : 'inherit' } }, notice.text),
        loading ? h('p', { role: 'status' }, t('loading')) : (list.phase === 'error' || ws.phase === 'error') ? h('p', { role: 'alert' }, t('loadFailed')) : !rows.length ? h('p', { style: { textAlign: 'center', padding: '40px 0', opacity: .65 } }, t('empty')) : h('ul', { style: { listStyle: 'none', margin: 0, padding: 0 } }, rows.map(row => h('li', { key: row.id, style: { borderBottom: '1px solid var(--dsw-alias-border-primary, #8883)', padding: '14px 0' } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } }, h('input', { type: 'checkbox', checked: selected.includes(row.id), disabled: !!pending, 'aria-label': `${t('select')}: ${row.title || row.id}`, onChange: () => toggle(row.id) }), h('div', { style: { flex: '1 1 180px', minWidth: 0 } }, h('div', { title: row.title, style: { fontWeight: 600, overflowWrap: 'anywhere' } }, row.title || t('untitled')), h('div', { style: { fontSize: 12, opacity: .6, marginTop: 5, overflowWrap: 'anywhere' } }, row.cwd || row.id), row.updatedAt && h('div', { style: { fontSize: 12, opacity: .6, marginTop: 3 } }, new Date(row.updatedAt).toLocaleString())),
          h('button', { type: 'button', style: button, disabled: !!pending, onClick: () => act(row.id, 'restore') }, pending === row.id ? t('busy') : t('restore')),
          h('button', { type: 'button', style: { ...button, color: 'var(--dsw-alias-status-error, #d9534f)' }, disabled: !!pending, onClick: () => { setBatchConfirm(null); setConfirm(row.id); setNotice(null); return check([row.id]) } }, t('delete'))),
          confirm === row.id && confirmBox([row.id], false)
        ))),
        orphanPanel
      )
    }
    return { name: 'archived-sessions', inject: ['slots', 'locale', 'sessions', 'workspaces'], apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'archived sessions locale')
      const t = ctx.locale.bind(NS)
      ctx.slots.inject('settings.section', () => ctx.effect(() => ctx.slots.register({ name: 'settings.section', id: 'archived-sessions', order: 35, label: () => t('nav'), locale: NS }, () => h(Page, { ctx, t })), 'archived sessions settings page'))
    } }
  }
})
