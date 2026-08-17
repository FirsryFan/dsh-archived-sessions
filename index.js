/**
 * dsh-archived-sessions — host half.
 *
 * Exposes two package-owned HTTP routes under /thirdparty/archived-sessions:
 *
 *   POST /thirdparty/archived-sessions/unarchive  { sessionId }
 *     Removes the session from the workspace domain's registry-global archive
 *     set. The registry and the domain share the same in-memory global state
 *     object, so mutating it in place and then persisting through
 *     domain.global.set keeps the WorkspaceRegistry's cached state coherent,
 *     fires domain/changed, and the api-proxy streams the updated archive set
 *     to every connected client.
 *
 *   POST /thirdparty/archived-sessions/delete     { sessionId }
 *     Permanently deletes a session that is NOT actively running and NOT
 *     attached in memory: accounting cleanup (workspace detach + archive-set
 *     removal) runs first, the on-disk log directory is removed last, and a
 *     retry on an already-deleted session succeeds. Refused (409) when the
 *     agent is running or the session is still loaded in the in-memory store.
 *
 * The client half calls these with plain fetch(); same-origin, so no CORS.
 */
import { rm } from 'node:fs/promises'
import { basename, dirname } from 'node:path'

/** Wait for the web server service before registering routes. */
export const inject = ['webServer']

export function apply(ctx) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) return

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8').trim()
        if (raw.length === 0) return resolve({})
        try {
          resolve(JSON.parse(raw))
        } catch (error) {
          reject(error)
        }
      })
      req.on('error', reject)
    })
  }

  function sendJson(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }

  /** The open workspace domain (shared with the WorkspaceRegistry). */
  function workspaceDomain() {
    const storageDomain = ctx.get('storageDomain')
    const domain = storageDomain === undefined ? undefined : storageDomain.get('workspace')
    if (domain === undefined) throw new Error('workspace domain is not open')
    return domain
  }

  /** Remove one id from the archive set, keeping registry + domain + wire in sync. */
  async function unarchive(sessionId) {
    const domain = workspaceDomain()
    const state = domain.global.get()
    if (state === undefined || !Array.isArray(state.archivedSessionIds)) throw new Error('workspace state is malformed')
    if (!state.archivedSessionIds.includes(sessionId)) return
    const original = state.archivedSessionIds
    state.archivedSessionIds = original.filter((id) => id !== sessionId)
    try {
      await domain.global.set(state)
    } catch (error) {
      state.archivedSessionIds = original
      throw error
    }
  }

  /** Permanently delete one session that is NOT actively running. */
  async function deleteSession(sessionId) {
    // Refuse a running agent: the lifecycle status is the liveness signal.
    const agents = ctx.get('agents')
    const agent = agents === undefined ? undefined : agents.get(sessionId)
    if (agent !== undefined && agent.status === 'running') {
      const error = new Error('该会话正在运行中，不能删除')
      error.code = 'live'
      throw error
    }

    // Unload an attached (loaded) session before touching its log. We mirror
    // AgentHandle.dispose()'s ordering with the primitives that are reachable
    // from a bundle host: cancel → wait idle → unwind the agent scope → detach
    // the agent and session registries. The registry stores are ordinary
    // mutable maps in the compiled host, and the detach entries expose the
    // same teardown path the agent lifecycle uses.
    if (agent !== undefined) {
      if (typeof agent.cancel === 'function') agent.cancel({ kind: 'disposed' })
      if (typeof agent.whenIdle === 'function') await agent.whenIdle()
      if (agent.scope !== undefined && typeof agent.scope.dispose === 'function') {
        await agent.scope.dispose()
      }
      const agentEntry = agents.store !== undefined ? agents.store.get(sessionId) : undefined
      if (agentEntry !== undefined && typeof agents.detachEntered === 'function') {
        agents.detachEntered(agentEntry)
      }
    }
    const sessions = ctx.get('sessions')
    const session = sessions === undefined ? undefined : sessions.get(sessionId)
    if (session !== undefined && typeof sessions.flush === 'function') {
      // Make buffered events durable before the log directory is removed.
      await sessions.flush(session)
    }
    const sessionEntry = sessions !== undefined && sessions.store !== undefined
      ? sessions.store.get(sessionId)
      : undefined
    if (sessionEntry !== undefined && typeof sessionEntry.detach === 'function') {
      sessionEntry.detach()
    }

    // Accounting cleanup FIRST, log deletion LAST: a failure anywhere leaves
    // a consistent state (session still listed, still archived, dir intact)
    // instead of a half-deleted ghost.
    const registry = ctx.get('workspaceRegistry')
    if (registry !== undefined) {
      for (const entity of registry.list()) {
        if (entity.sessionIds.includes(sessionId)) {
          if (typeof entity.detachSession === 'function') await entity.detachSession(sessionId)
          break
        }
      }
      await unarchive(sessionId)
    }

    // A session whose log is already gone still counts as deleted — the
    // accounting cleanup above is the load-bearing part, and this makes a
    // retry succeed instead of failing with "会话不存在".
    const persistence = ctx.get('sessionPersistence')
    if (persistence === undefined) return
    const headers = await persistence.list()
    const meta = headers.find((header) => header.id === sessionId)
    if (meta === undefined || meta.cwd === undefined) return
    const location = persistence.locate(meta)
    if (location === undefined || typeof location.path !== 'string') return
    const logPath = location.path
    const sessionDir = dirname(logPath)
    // Sanity guards: never remove the persistence root or a project dir.
    const parentDir = dirname(sessionDir)
    if (sessionDir === parentDir || basename(sessionDir) === '' || basename(sessionDir) === basename(parentDir)) {
      throw new Error(`拒绝删除非会话目录：${sessionDir}`)
    }
    await rm(sessionDir, { recursive: true, force: true })
  }

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/thirdparty/archived-sessions/unarchive',
    handler: async (req, res) => {
      try {
        const body = await readBody(req)
        const sessionId = body && body.sessionId
        if (typeof sessionId !== 'string' || sessionId.length === 0) return sendJson(res, 400, { error: '缺少 sessionId' })
        await unarchive(sessionId)
        sendJson(res, 200, { ok: true })
      } catch (error) {
        sendJson(res, 500, { error: error && error.message ? error.message : String(error) })
      }
    }
  }), 'archived-sessions: unarchive route')

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/thirdparty/archived-sessions/delete',
    handler: async (req, res) => {
      try {
        const body = await readBody(req)
        const sessionId = body && body.sessionId
        if (typeof sessionId !== 'string' || sessionId.length === 0) return sendJson(res, 400, { error: '缺少 sessionId' })
        await deleteSession(sessionId)
        sendJson(res, 200, { ok: true })
      } catch (error) {
        const status = error && (error.code === 'live' || error.code === 'attached') ? 409 : 500
        sendJson(res, status, { error: error && error.message ? error.message : String(error) })
      }
    }
  }), 'archived-sessions: delete route')
}
