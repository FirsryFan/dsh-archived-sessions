/**
 * dsh-archived-sessions — client half.
 *
 * 1. Registers a top-level Settings section「归档会话 / Archived Sessions」
 *    (settings.section list slot) listing every archived session grouped by
 *    owning workspace, with 恢复 (restore) and 删除 (permanent delete) per row.
 * 2. Registers its settings entry with dsh-thirdparty-settings
 *    (window.__DSH_THIRDPARTY__) so the third-party list's「设置」button
 *    navigates straight to this page.
 * 3. Augments the left sidebar session rows with a per-row delete button
 *    (「直接在左栏删除」): resolves the session by row title, confirms, then
 *    calls the host delete route and refreshes the lists.
 *
 * Data flows: archived ids + workspace grouping come from the client
 * workspace store (useWorkspaces); session titles from useSessions. The
 * restore/delete mutations go to the host over package-owned HTTP routes.
 */
window.__ModuleLoader__.load({
  id: 'dsh-archived-sessions',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')

    var ARCHIVED_NS = 'archivedSessions'
    // Must equal the bundle id (package name) so dsh-thirdparty-settings can
    // merge this settings entry onto the plugin's single list row instead of
    // listing a second row without a settings button.
    var ENTRY_ID = 'dsh-archived-sessions'

    var zh = {
      nav: '归档会话',
      pageTitle: '已归档会话',
      pageDesc: '以下会话已从侧边栏隐藏，日志仍保留在磁盘上。可以恢复，或彻底删除（连同日志文件）。',
      empty: '暂无归档会话',
      ungrouped: '未分组',
      noTitle: '未命名会话',
      restore: '恢复',
      delete: '删除',
      restoring: '恢复中…',
      deleting: '删除中…',
      restoreOk: '已恢复',
      deleteOk: '已删除',
      confirmDelete: '彻底删除会话「{title}」？该会话的日志文件将被删除，且不可恢复。',
      managerTitle: '归档会话管理'
    }
    var en = {
      nav: 'Archived Sessions',
      pageTitle: 'Archived Sessions',
      pageDesc: 'These sessions are hidden from the sidebar; their logs remain on disk. Restore them, or delete them permanently (logs included).',
      empty: 'No archived sessions',
      ungrouped: 'Ungrouped',
      noTitle: 'Untitled session',
      restore: 'Restore',
      delete: 'Delete',
      restoring: 'Restoring…',
      deleting: 'Deleting…',
      restoreOk: 'Restored',
      deleteOk: 'Deleted',
      confirmDelete: 'Permanently delete session "{title}"? Its log files will be removed and cannot be recovered.',
      managerTitle: 'Archived Sessions Manager'
    }

    function parseResponse(res) {
      return res.json().catch(function () { return {} }).then(function (body) {
        if (!res.ok) {
          var error = new Error(body.error || ('HTTP ' + res.status))
          error.body = body
          throw error
        }
        return body
      })
    }

    function apiFor(ctx) {
      return {
        unarchive: function (sessionId) {
          return fetch('/thirdparty/archived-sessions/unarchive', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: sessionId })
          }).then(parseResponse)
        },
        deleteSession: function (sessionId) {
          return fetch('/thirdparty/archived-sessions/delete', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: sessionId })
          }).then(parseResponse).then(function (result) {
            var sessions = ctx && ctx.get ? ctx.get('sessions') : undefined
            if (sessions !== undefined) {
              var snap = sessions.list && typeof sessions.list.getSnapshot === 'function' ? sessions.list.getSnapshot() : null
              if (snap !== null && snap.current === sessionId && typeof sessions.clear === 'function') sessions.clear()
              if (typeof sessions.refresh === 'function') sessions.refresh()
            }
            var workspaces = ctx && ctx.get ? ctx.get('workspaces') : undefined
            if (workspaces !== undefined && typeof workspaces.refresh === 'function') workspaces.refresh()
            return result
          })
        }
      }
    }

    /* ------------------------- settings page ------------------------- */

    function sessionTitle(sessions, id) {
      var entry = sessions && sessions.byId ? sessions.byId[id] : undefined
      if (entry !== undefined) return entry.title || entry.displayTitle || ''
      return ''
    }

    function ArchivedSessionsPage(props) {
      var useSessions = props.useSessions
      var useWorkspaces = props.useWorkspaces
      var api = props.api
      var t = props.t
      var sessions = useSessions(function (state) { return state })
      var workspaces = useWorkspaces(function (state) { return state })
      var busyState = React.useState({})
      var busy = busyState[0]
      var setBusy = busyState[1]
      var noticeState = React.useState(null)
      var notice = noticeState[0]
      var setNotice = noticeState[1]

      var archivedIds = (workspaces && workspaces.archivedSessionIds) || []
      var archivedSet = {}
      archivedIds.forEach(function (id) { archivedSet[id] = true })
      var items = (workspaces && workspaces.items) || []
      var groups = []
      var accounted = {}
      items.forEach(function (workspace) {
        var ids = (workspace.sessionIds || []).filter(function (id) { return archivedSet[id] })
        if (ids.length === 0) return
        groups.push({ workspace: workspace, ids: ids })
        ids.forEach(function (id) { accounted[id] = true })
      })
      var ungrouped = archivedIds.filter(function (id) { return !accounted[id] })

      function act(id, busyKey, title, fn, okKey) {
        if (busy[id]) return
        var next = {}
        next[id] = busyKey
        setBusy(next)
        fn().then(function () {
          var after = {}
          after[id] = false
          setBusy(after)
          setNotice({ text: t(okKey) + '「' + (title || t('noTitle')) + '」', tone: 'ok' })
        }).catch(function (err) {
          var after = {}
          after[id] = false
          setBusy(after)
          setNotice({ text: (err && err.message) || String(err), tone: 'error' })
        })
      }

      function confirmDelete(title, id) {
        var message = (t('confirmDelete') || '').replace('{title}', title || t('noTitle'))
        if (!window.confirm(message)) return
        act(id, t('deleting'), title, function () { return api.deleteSession(id) }, t('deleteOk'))
      }

      function sessionRow(id, key) {
        var title = sessionTitle(sessions, id) || t('noTitle')
        var state = busy[id] ? String(busy[id]) : ''
        return React.createElement('div', { key: key, style: {
          display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 10px',
          border: '1px solid rgba(148,178,255,.22)', borderRadius: '8px',
          background: 'var(--dsw-alias-bg-layer-1,rgba(20,27,41,.45))'
        } },
          React.createElement('div', { style: { minWidth: 0, flex: 1 } },
            React.createElement('div', { style: { fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, title),
            React.createElement('div', { style: { fontSize: '11px', opacity: .55, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, id)
          ),
          state !== '' && React.createElement('span', { style: { fontSize: '12px', opacity: .7 } }, state),
          React.createElement('button', {
            type: 'button', disabled: !!state,
            style: { padding: '3px 10px', borderRadius: '7px', cursor: 'pointer', border: '1px solid rgba(148,178,255,.4)', background: 'transparent', color: 'inherit', fontSize: '12px' },
            onClick: function () { act(id, t('restoring'), title, function () { return api.unarchive(id) }, t('restoreOk')) }
          }, t('restore')),
          React.createElement('button', {
            type: 'button', disabled: !!state,
            style: { padding: '3px 10px', borderRadius: '7px', cursor: 'pointer', border: '1px solid rgba(229,72,77,.45)', background: 'transparent', color: 'var(--dsw-alias-state-error-primary,#e5484d)', fontSize: '12px' },
            onClick: function () { confirmDelete(title, id) }
          }, t('delete'))
        )
      }

      var rows = []
      groups.forEach(function (group) {
        rows.push(React.createElement('div', { key: group.workspace.workspaceId + ':h', style: {
          fontSize: '13px', fontWeight: 600, opacity: .85, margin: '14px 2px 6px'
        } }, group.workspace.title || group.workspace.path))
        group.ids.forEach(function (id) { rows.push(sessionRow(id, group.workspace.workspaceId + ':' + id)) })
      })
      if (ungrouped.length > 0) {
        rows.push(React.createElement('div', { key: 'ungrouped:h', style: { fontSize: '13px', fontWeight: 600, opacity: .85, margin: '14px 2px 6px' } }, t('ungrouped')))
        ungrouped.forEach(function (id) { rows.push(sessionRow(id, 'u:' + id)) })
      }

      return React.createElement('div', { style: { maxWidth: 760, color: 'var(--dsw-alias-label-primary)', display: 'flex', flexDirection: 'column', gap: '10px' } },
        React.createElement('h2', { style: { margin: 0, fontSize: 18, fontWeight: 600 } }, t('pageTitle')),
        React.createElement('p', { style: { color: 'var(--dsw-alias-label-tertiary)', margin: 0, fontSize: 13 } }, t('pageDesc')),
        notice !== null && React.createElement('div', { style: { fontSize: 12, color: notice.tone === 'ok' ? 'var(--dsw-alias-state-business-primary,#4cc38a)' : 'var(--dsw-alias-state-error-primary,#e5484d)' } }, notice.text),
        rows.length === 0
          ? React.createElement('p', { style: { opacity: .55, fontSize: 13 } }, t('empty'))
          : React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } }, rows)
      )
    }

    /* -------------------- third-party manager entry -------------------- */

    function openArchivedSessions(t) {
      var tries = 0
      function step() {
        tries += 1
        if (tries > 30) return
        var overlay = document.querySelector('.VOzbGW_overlay')
        if (overlay === null) {
          var trigger = document.querySelector('.VOzbGW_trigger')
          if (trigger === null) { setTimeout(step, 150); return }
          trigger.click()
          setTimeout(step, 150)
          return
        }
        var cells = document.querySelectorAll('.VOzbGW_navCell')
        var label = t('nav')
        var target = null
        for (var i = 0; i < cells.length; i++) {
          if ((cells[i].textContent || '').indexOf(label) !== -1) { target = cells[i]; break }
        }
        if (target === null) { setTimeout(step, 150); return }
        target.click()
      }
      step()
    }

    function registerWithManager(entry) {
      if (window.__DSH_THIRDPARTY__ && typeof window.__DSH_THIRDPARTY__.register === 'function') {
        return window.__DSH_THIRDPARTY__.register(entry)
      }
      return null
    }

    /* --------------------- sidebar row delete --------------------- */

    function installRowDelete(ctx, api, t) {
      var style = document.createElement('style')
      style.textContent = '.dsh-as-del{width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center;border:0;background:transparent;color:var(--dsw-alias-label-tertiary,#8b9bb5);border-radius:50%;cursor:pointer;padding:0;opacity:0;transition:opacity .12s ease,color .12s ease;flex:none}.dsh-as-del:hover{opacity:1!important;color:var(--dsw-alias-state-error-primary,#e5484d)!important}.YDXeBa_sessionRow:hover .dsh-as-del{opacity:.8}'
      document.head.appendChild(style)

      function titleToId(title) {
        var sessions = ctx && ctx.get ? ctx.get('sessions') : undefined
        var snap = sessions && sessions.list && typeof sessions.list.getSnapshot === 'function' ? sessions.list.getSnapshot() : null
        if (snap === null || !snap.byId) return undefined
        var found
        Object.keys(snap.byId).some(function (id) {
          var s = snap.byId[id]
          if ((s.title || s.displayTitle) === title) { found = id; return true }
          return false
        })
        return found
      }

      function addButton(row) {
        if (row.querySelector('[data-dsh-as-del]') !== null) return
        var actions = row.querySelector('.YDXeBa_rowActions')
        if (actions === null) return
        var btn = document.createElement('button')
        btn.type = 'button'
        btn.setAttribute('data-dsh-as-del', '1')
        btn.className = 'dsh-as-del'
        btn.title = t('delete')
        btn.setAttribute('aria-label', t('delete'))
        btn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>'
        btn.addEventListener('click', function (e) {
          e.stopPropagation()
          e.preventDefault()
          var titleEl = row.querySelector('.YDXeBa_title')
          var title = titleEl === null ? '' : (titleEl.textContent || '').trim()
          var sessionId = titleToId(title)
          if (sessionId === undefined) {
            window.alert('无法识别会话「' + title + '」，请刷新页面后重试')
            return
          }
          var message = (t('confirmDelete') || '').replace('{title}', title || t('noTitle'))
          if (!window.confirm(message)) return
          api.deleteSession(sessionId).catch(function (err) {
            window.alert((err && err.message) || String(err))
          })
        })
        actions.insertBefore(btn, actions.firstChild)
      }

      function scan() {
        var rows = document.querySelectorAll('.YDXeBa_sessionRow')
        for (var i = 0; i < rows.length; i++) addButton(rows[i])
      }
      var observer = new MutationObserver(scan)
      observer.observe(document.body, { childList: true, subtree: true })
      scan()

      return function () {
        observer.disconnect()
        if (style.parentNode !== null) style.parentNode.removeChild(style)
        var buttons = document.querySelectorAll('[data-dsh-as-del]')
        for (var i = 0; i < buttons.length; i++) {
          var parent = buttons[i].parentNode
          if (parent !== null) parent.removeChild(buttons[i])
        }
      }
    }

    /* ------------------------------ apply ------------------------------ */

    function apply(ctx) {
      var t = function (key) { return zh[key] !== undefined ? zh[key] : key }

      if (ctx && ctx.locale && typeof ctx.locale.register === 'function') {
        if (typeof ctx.effect === 'function') {
          ctx.effect(function () { return ctx.locale.register(ARCHIVED_NS, { zh: zh, en: en }) }, 'archived-sessions: locale')
        } else {
          ctx.locale.register(ARCHIVED_NS, { zh: zh, en: en })
        }
        if (typeof ctx.locale.bind === 'function') {
          t = ctx.locale.bind(ARCHIVED_NS)
        }
      }

      var api = apiFor(ctx)

      if (ctx && ctx.slots && typeof ctx.slots.inject === 'function') {
        var injectSection = function () {
          return ctx.slots.register({
            name: 'settings.section',
            id: 'archived-sessions',
            order: 30,
            label: function () { return t('nav') }
          }, function (props) {
            return React.createElement(ArchivedSessionsPage, Object.assign({}, props, { api: api, t: t }))
          })
        }
        if (typeof ctx.effect === 'function') {
          ctx.effect(function () { return ctx.slots.inject('settings.section', injectSection) }, 'archived-sessions: section')
        } else {
          ctx.slots.inject('settings.section', injectSection)
        }
      }

      // settings entry for the third-party manager (retry until it is up)
      var tries = 0
      var unregister = null
      function tryRegister() {
        tries += 1
        if (unregister !== null) return
        var handle = registerWithManager({
          id: ENTRY_ID,
          title: t('managerTitle'),
          version: '0.1.0',
          onOpen: function () { openArchivedSessions(t) }
        })
        if (handle !== null) unregister = handle
        else if (tries < 60) setTimeout(tryRegister, 250)
      }
      tryRegister()

      // sidebar per-row delete
      var disposeRows = installRowDelete(ctx, api, t)

      return function () {
        if (unregister !== null) unregister()
        disposeRows()
      }
    }

    exports.inject = ['slots', 'locale', 'sessions', 'workspaces']
    exports.apply = apply
    return module.exports
  }
})
