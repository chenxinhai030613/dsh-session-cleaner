/**
 * Host half of the `dsh-session-cleaner` bundle.
 *
 * DeepSeek Harness can archive a Session but deliberately has no Session
 * deletion: the persistence seam documents "no delete or retention interface"
 * and the shipped JSONL backend never removes a stored log. This bundle adds
 * deletion as an explicit, local, out-of-band maintenance operation on top of
 * the same durable state DSH itself owns:
 *
 * - the per-Session JSONL log directory under `$DSH_HOME/sessions`;
 * - the derived projection cache record under
 *   `$DSH_HOME/storages/session_projcache/sessions` (titles, turn outline and
 *   other cached projection values);
 * - the Workspace registry references (`sessionIds` order, archive set, pin
 *   set) through the *public* `ctx.workspaceRegistry` service, never by
 *   editing `workspace.json` behind a running process.
 *
 * A Session that is live in this Host process still owns its JSONL write
 * handle (the seam keeps it open until `session/disposed`), so its log cannot
 * be removed safely on Windows. Such Sessions are not deleted now: they are
 * appended to a small durable pending queue and swept once at the next Host
 * boot, before any browser can resume them.
 *
 * The browser half (`./client`) drives this half through one fenced HTTP route
 * mounted on the existing Web server, `/session-cleaner/api/<method>`.
 *
 * @module dsh-session-cleaner
 */

import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** Plugin identity for profile loader rows. */
export const name = 'dsh-session-cleaner'

/** Host services this bundle needs before it may mount. */
export const inject = ['webServer', 'sessions', 'sessionPersistence', 'workspaceRegistry']

/** Route prefix owned by this bundle. */
export const ROUTE_PREFIX = '/session-cleaner/api'

/** Largest JSON request body accepted by the route (a batch id list is tiny). */
const MAX_BODY_BYTES = 256 * 1024

/** Largest number of explicit Session ids one request may name. */
const MAX_REQUEST_IDS = 1000

/** A Session id must be usable as a JSONL backend path segment and cache key. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/

/** Per-record projection cache keys are restricted by the JSON storage backend. */
const CACHE_KEY_PATTERN = /^[A-Za-z0-9_-]+$/

/** Delay before the boot-time pending sweep, letting the registry finish bootstrapping. */
const PENDING_SWEEP_DELAY_MS = 800

/** Grace period after detaching a live Session before touching its files and cache. */
const DETACH_SETTLE_MS = 80

/** Grace period after a force-detached delete before the projection cache is purged again. */
const CACHE_SETTLE_MS = 140

/* -------------------------------------------------------------------------- */
/* Home / directory resolution                                                */
/* -------------------------------------------------------------------------- */

/** Expand a leading `~/` or `~\` against the OS home directory. */
function expandHome(raw) {
  if (raw === '~') return homedir()
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return join(homedir(), raw.slice(2))
  return raw
}

/** Resolved harness home. Mirrors `dsh-home-paths`: configured path, else `$DSH_HOME`, else `~/.dsh`. */
const DSH_HOME = (() => {
  const configured = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return resolve(configured === '' ? join(homedir(), '.dsh') : expandHome(configured))
})()

/** Root of the shipped JSONL session store. */
const SESSIONS_ROOT = join(DSH_HOME, 'sessions')

/** Per-record projection cache directory of the shipped JSON storage backend. */
const PROJECTION_CACHE_ROOT = join(DSH_HOME, 'storages', 'session_projcache', 'sessions')

/** Directory and file of the durable "delete at next boot" queue. */
const QUEUE_DIR = join(DSH_HOME, 'session-cleaner')
const QUEUE_FILE = join(QUEUE_DIR, 'pending.json')

/** Diagnostic record of the latest pending-queue sweep. */
const LAST_SWEEP_FILE = join(QUEUE_DIR, 'last-sweep.json')

/**
 * Effective storage paths. A profile that relocates the JSONL backend or the
 * storage root can point this bundle at the same place through its plugin
 * config (`sessionsRoot`, `projectionCacheRoot`); the defaults match an
 * unmodified `$DSH_HOME`.
 */
const paths = {
  sessionsRoot: SESSIONS_ROOT,
  projectionCacheRoot: PROJECTION_CACHE_ROOT,
}

/**
 * Apply optional path overrides from the plugin config row.
 * @param {object | undefined} config - Cordis plugin config.
 */
export function configure(config) {
  if (!config || typeof config !== 'object') return
  if (typeof config.sessionsRoot === 'string' && config.sessionsRoot.trim() !== '') {
    paths.sessionsRoot = resolve(expandHome(config.sessionsRoot.trim()))
  }
  if (typeof config.projectionCacheRoot === 'string' && config.projectionCacheRoot.trim() !== '') {
    paths.projectionCacheRoot = resolve(expandHome(config.projectionCacheRoot.trim()))
  }
}

/**
 * Encode an arbitrary string as one safe path segment, identically to the
 * shipped JSONL persistence backend, so this plugin can locate a stored
 * Session directory without importing that package (a linked plugin resolves
 * peers from its own directory, where `@deepseek-ai/*` is not installed).
 *
 * @param {string} raw - session id.
 * @returns {string} injective, traversal-free path segment.
 */
export function encodeSegment(raw) {
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index)
    const character = String.fromCharCode(code)
    if (character !== '~' && /^[A-Za-z0-9._-]$/.test(character)) out += character
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}

/**
 * Find one stored Session's directory. The project directory is derived from
 * the Session cwd, so the directory is discovered by scanning the store's
 * project folders for the encoded id instead of trusting any caller path.
 *
 * @param {string} sessionId - session identity.
 * @returns {Promise<string | undefined>} the session-owned directory, when present.
 */
export async function locateSessionDir(sessionId) {
  const segment = encodeSegment(sessionId)
  let entries
  try {
    entries = await readdir(paths.sessionsRoot, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const candidate = join(paths.sessionsRoot, entry.name, segment)
    try {
      const info = await stat(candidate)
      if (info.isDirectory()) return candidate
    } catch {
      // Not this project folder; keep scanning.
    }
  }
  return undefined
}

/** Remove the now-empty project folder a deleted Session used to live in. */
async function removeEmptyProjectDir(sessionDir) {
  const projectDir = dirname(sessionDir)
  try {
    const rest = await readdir(projectDir)
    if (rest.length === 0) await rm(projectDir, { recursive: false, force: true })
  } catch {
    // A concurrent write or a permission problem only leaves an empty folder.
  }
}

/* -------------------------------------------------------------------------- */
/* Deferred delete queue                                                      */
/* -------------------------------------------------------------------------- */

/** Read the durable "delete at next boot" id list (never throws). */
export async function readPending() {
  try {
    const raw = await readFile(QUEUE_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    const ids = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.ids) ? parsed.ids : []
    return [...new Set(ids.filter((id) => typeof id === 'string' && SESSION_ID_PATTERN.test(id)))]
  } catch {
    return []
  }
}

/** Atomically replace the pending id list. */
export async function writePending(ids) {
  if (ids.length === 0) {
    try {
      await rm(QUEUE_FILE, { force: true })
    } catch {
      // Already gone.
    }
    return
  }
  await mkdir(QUEUE_DIR, { recursive: true })
  const temporary = QUEUE_FILE + '.' + String(process.pid) + '.' + Date.now().toString(36) + '.tmp'
  await writeFile(temporary, JSON.stringify({ version: 1, ids }, null, 2), 'utf8')
  await rename(temporary, QUEUE_FILE)
}

/** Append one Session id to the pending queue (idempotent). */
async function enqueuePending(sessionId) {
  const ids = await readPending()
  if (ids.includes(sessionId)) return
  ids.push(sessionId)
  await writePending(ids)
}

/** Drop ids that have now been deleted from the pending queue. */
async function dequeuePending(sessionIds) {
  const remove = new Set(sessionIds)
  const ids = await readPending()
  const next = ids.filter((id) => !remove.has(id))
  if (next.length !== ids.length) await writePending(next)
  return next
}

/* -------------------------------------------------------------------------- */
/* Deletion                                                                   */
/* -------------------------------------------------------------------------- */

/** One short, safe diagnostic message line. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Log a non-fatal cleanup problem without failing the request. */
function warn(ctx, scope, error) {
  try {
    ctx.logger?.warn?.(`[session-cleaner] ${scope}: ${messageOf(error)}`)
  } catch {
    // Logging must never fail a deletion.
  }
}

/** Whether a Session is live in this Host process (and therefore owns its log handle). */
function isLive(ctx, sessionId) {
  try {
    return ctx.sessions.get(sessionId) !== undefined
  } catch {
    return false
  }
}

/**
 * Release one live Session that has no running work.
 *
 * `session/fork` creates its child through `ctx.agents.create()` but discards
 * the returned AgentHandle, so forked Sessions stay live for the whole Host
 * process and keep their JSONL write handle open. The registry and session
 * store still expose the low-level detach primitives they use internally, so
 * an idle live Session can be unregistered and disposed before its files are
 * removed: the `session/disposed` edge closes the persistence handle and lets
 * the projection cache write its final checkpoint (purged below).
 *
 * This is deliberately limited to Sessions whose activity waterfall reported
 * nothing; running work is refused earlier.
 *
 * @param {object} ctx - Host plugin context.
 * @param {string} sessionId - Session identity.
 * @returns {boolean} whether at least one live registration was detached.
 */
function detachLiveSession(ctx, sessionId) {
  let detached = false
  // The AgentRegistry owns the live agent next to the session; detaching it
  // announces `agent/disposed` so its listeners stop treating it as live.
  try {
    const agents = ctx.get('agents')
    const store = agents && agents.store
    if (store && typeof store.get === 'function' && typeof agents.detachEntered === 'function') {
      const entry = store.get(sessionId)
      if (entry !== undefined) {
        agents.detachEntered(entry)
        detached = true
      }
    }
  } catch (error) {
    warn(ctx, 'detach live agent', error)
  }
  // Detach the SessionStore entry: this closes the persistence write handle
  // through its `session/disposed` listener.
  try {
    const sessions = ctx.sessions
    if (typeof sessions.liveEntryFor === 'function' && typeof sessions.detachEntered === 'function') {
      const session = isLive(ctx, sessionId) ? sessions.get(sessionId) : undefined
      if (session !== undefined) {
        const entry = sessions.liveEntryFor(session)
        if (entry !== undefined) {
          sessions.detachEntered(entry)
          detached = true
        }
      }
    }
  } catch (error) {
    warn(ctx, 'detach live session', error)
  }
  return detached
}

/** One microtask-friendly pause so disposal listeners can run. */
function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

/** Ask the Workspace registry's activity providers what a Session still has running. */
async function sessionActivity(ctx, sessionId) {
  if (typeof ctx.waterfall !== 'function') return []
  try {
    const activity = await ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([]))
    return Array.isArray(activity) ? activity : []
  } catch {
    return []
  }
}

/** Whether the Host (live or persisted) knows one Session. */
async function sessionIsKnown(ctx, sessionId) {
  if (isLive(ctx, sessionId)) return true
  try {
    await ctx.sessionPersistence.stat(sessionId)
    return true
  } catch {
    return false
  }
}

/** Remove the derived projection-cache record (title, outline, cached values). */
async function purgeProjectionCache(sessionId) {
  if (!CACHE_KEY_PATTERN.test(sessionId)) return
  const prefix = sessionId + '.json'
  try {
    const entries = await readdir(paths.projectionCacheRoot)
    for (const name of entries) {
      if (name === prefix || name.startsWith(prefix + '.bak.')) {
        await rm(join(paths.projectionCacheRoot, name), { force: true })
      }
    }
  } catch {
    // Missing cache root or record: nothing derived to remove.
  }
}

/**
 * Drop every Workspace-registry reference to a Session: the archive set, the
 * pin set, and the ordered `sessionIds` accounting of each Workspace. Only
 * public registry methods are used, so the running process's in-memory state
 * and the durable `workspace.json` stay consistent.
 */
async function purgeRegistry(ctx, sessionId) {
  const registry = ctx.workspaceRegistry
  try {
    await registry.unarchiveSession(sessionId)
  } catch (error) {
    warn(ctx, 'unarchive reference', error)
  }
  try {
    await registry.unpinSession(sessionId)
  } catch (error) {
    warn(ctx, 'unpin reference', error)
  }
  let entities = []
  try {
    entities = registry.list()
  } catch (error) {
    warn(ctx, 'list workspaces', error)
    return
  }
  for (const entity of entities) {
    const detach = entity && entity.detachSession
    if (typeof detach !== 'function') continue
    try {
      // `detachSession` is a no-op for an unaccounted id, so it is always safe.
      await detach.call(entity, sessionId)
    } catch (error) {
      warn(ctx, 'detach workspace session', error)
    }
  }
}

/**
 * Expand a delete request with the Session's direct and indirect subagent
 * descendants. Subagent children are hidden from the sidebar but live on the
 * same disk, so deleting a conversation without them would orphan data.
 *
 * @param {object} ctx - Host plugin context.
 * @param {string[]} roots - requested Session ids.
 * @returns {Promise<string[]>} roots plus every descendant, roots first.
 */
async function collectCascade(ctx, roots) {
  let snapshots = []
  try {
    snapshots = await ctx.sessionPersistence.list()
  } catch (error) {
    warn(ctx, 'list stored sessions for cascade', error)
    return [...new Set(roots)]
  }
  const childrenByParent = new Map()
  for (const snapshot of snapshots) {
    const header = snapshot && snapshot.header
    if (!header || header.origin !== 'subagent' || typeof header.parentSession !== 'string') continue
    const bucket = childrenByParent.get(header.parentSession) ?? []
    bucket.push(header.id)
    childrenByParent.set(header.parentSession, bucket)
  }
  const ordered = []
  const seen = new Set()
  const queue = [...roots]
  while (queue.length > 0) {
    const id = queue.shift()
    if (seen.has(id)) continue
    seen.add(id)
    ordered.push(id)
    for (const child of childrenByParent.get(id) ?? []) queue.push(child)
  }
  return ordered
}

/**
 * Delete exactly one Session. Never throws for a per-Session problem: the
 * returned status is part of the response so a batch can finish the rest.
 *
 * Status values: `deleted`, `deferred` (live now, queued for next boot),
 * `active` (still has running work), `not-found` (references were cleaned but
 * no stored log existed), `invalid`, `failed`.
 *
 * A live Session without running work is force-detached (see
 * {@link detachLiveSession}) and deleted immediately; `deferLive: true` keeps
 * the old queue-for-next-boot behavior for callers that prefer it.
 *
 * @param {object} ctx - Host plugin context.
 * @param {string} sessionId - Session identity.
 * @param {{deferLive?: boolean}} options - live handling.
 * @returns {Promise<{id: string, status: string, activity?: number, code?: string, message?: string}>}
 */
export async function deleteOne(ctx, sessionId, options = {}) {
  if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
    return { id: String(sessionId ?? ''), status: 'invalid' }
  }
  const activity = await sessionActivity(ctx, sessionId)
  if (activity.length > 0) return { id: sessionId, status: 'active', activity: activity.length }

  let forceDetached = false
  if (isLive(ctx, sessionId)) {
    if (options.deferLive === true) {
      try {
        await enqueuePending(sessionId)
        return { id: sessionId, status: 'deferred', activity: 0 }
      } catch (error) {
        return { id: sessionId, status: 'failed', code: 'defer', message: messageOf(error) }
      }
    }
    forceDetached = detachLiveSession(ctx, sessionId)
    if (forceDetached) await delay(DETACH_SETTLE_MS)
    if (isLive(ctx, sessionId)) {
      // The running Host still owns this Session and this build does not
      // expose a working detach primitive; keep it queued for the next boot.
      try {
        await enqueuePending(sessionId)
        return { id: sessionId, status: 'deferred', activity: 0 }
      } catch (error) {
        return { id: sessionId, status: 'live', activity: 0, message: messageOf(error) }
      }
    }
  }

  const sessionDir = await locateSessionDir(sessionId)
  const known = sessionDir !== undefined || (await sessionIsKnown(ctx, sessionId))
  if (!known) {
    // The durable registry may still reference a Session whose log is already
    // gone (for example after a manual file removal). Clean those references.
    await purgeProjectionCache(sessionId)
    await purgeRegistry(ctx, sessionId)
    return { id: sessionId, status: 'not-found' }
  }

  if (sessionDir !== undefined) {
    try {
      await rm(sessionDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 120 })
    } catch (error) {
      return { id: sessionId, status: 'failed', code: 'locked', message: messageOf(error) }
    }
    await removeEmptyProjectDir(sessionDir)
  }

  await purgeProjectionCache(sessionId)
  await purgeRegistry(ctx, sessionId)
  if (forceDetached) {
    // Detaching emitted `session/disposed`, and the projection cache writes a
    // final checkpoint on that edge. Purge once more after it settles so no
    // title/outline residue is left behind for a Session that no longer exists.
    await delay(CACHE_SETTLE_MS)
    await purgeProjectionCache(sessionId)
  }
  return { id: sessionId, status: 'deleted' }
}

/** Aggregate per-Session statuses into the counts the browser half reports. */
export function summarize(results) {
  const pick = (status) => results.filter((result) => result.status === status).map((result) => result.id)
  return {
    results,
    deleted: pick('deleted'),
    deferred: pick('deferred'),
    active: pick('active'),
    live: pick('live'),
    missing: pick('not-found'),
    failed: results.filter((result) => result.status === 'failed' || result.status === 'invalid'),
  }
}

/**
 * Serialize every mutation in this Host process: deletions, queue writes and
 * startup sweeps must not interleave (the Workspace registry already
 * serializes its own writes, but the pending file is ours).
 */
let mutationChain = Promise.resolve()

/** Queue one mutation behind the previous one. */
export function serialize(task) {
  const run = mutationChain.then(task, task)
  mutationChain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/** Expand, delete, aggregate. Runs inside the mutation queue. */
async function deleteMany(ctx, ids, options) {
  const roots = [...new Set(ids.filter((id) => typeof id === 'string'))]
  const targets = options.cascade === false ? roots : await collectCascade(ctx, roots)
  const results = []
  for (const id of targets) results.push(await deleteOne(ctx, id, options))
  const settled = results
    .filter((result) => result.status === 'deleted' || result.status === 'not-found')
    .map((result) => result.id)
  if (settled.length > 0) {
    try {
      await dequeuePending(settled)
    } catch (error) {
      warn(ctx, 'clear pending queue entries', error)
    }
  }
  return results
}

/**
 * Persist the outcome of one pending sweep so a user (or the browser half) can
 * see why queued ids were kept instead of deleted.
 * @param {object} report - sweep diagnostics.
 */
async function recordSweep(report) {
  try {
    await mkdir(QUEUE_DIR, { recursive: true })
    const temporary = LAST_SWEEP_FILE + '.' + String(process.pid) + '.tmp'
    await writeFile(temporary, JSON.stringify(report, null, 2), 'utf8')
    await rename(temporary, LAST_SWEEP_FILE)
  } catch {
    // Diagnostics are best-effort.
  }
}

/**
 * Sweep the pending queue once. Called at Host boot (when no browser can have
 * resumed a Session yet) and on demand through `sweep`.
 */
export async function processPending(ctx) {
  return serialize(async () => {
    const ids = await readPending()
    if (ids.length === 0) {
      await recordSweep({ at: new Date().toISOString(), results: [], swept: [], kept: [] })
      return { swept: [], kept: [], results: [] }
    }
    const results = await deleteMany(ctx, ids, { deferLive: false, cascade: true })
    const settled = results.filter((result) => result.status === 'deleted' || result.status === 'not-found').map((result) => result.id)
    const kept = await dequeuePending(settled)
    await recordSweep({ at: new Date().toISOString(), results, swept: settled, kept })
    return { swept: settled, kept, results }
  })
}

/**
 * Inspect one Session's deletability without changing anything.
 * @param {object} ctx - Host plugin context.
 * @param {string} sessionId - Session identity.
 * @returns {Promise<object>} live/activity/filesystem facts.
 */
export async function probeOne(ctx, sessionId) {
  const live = isLive(ctx, sessionId)
  const activity = await sessionActivity(ctx, sessionId)
  const sessionDir = await locateSessionDir(sessionId)
  const known = sessionDir !== undefined || (await sessionIsKnown(ctx, sessionId))
  let agentLive = false
  try {
    agentLive = Boolean(ctx.get('agents')?.get?.(sessionId))
  } catch {
    agentLive = false
  }
  const canDetach =
    typeof ctx.sessions.liveEntryFor === 'function' && typeof ctx.sessions.detachEntered === 'function'
  return {
    id: sessionId,
    live,
    agent: agentLive,
    activity: activity.length,
    dir: sessionDir !== undefined,
    known,
    canDetach,
  }
}

/* -------------------------------------------------------------------------- */
/* HTTP trust fence                                                           */
/* -------------------------------------------------------------------------- */

/** Case-sensitive header read that ignores array/missing values. */
function headerOf(headers, key) {
  const value = headers ? headers[key] : undefined
  return typeof value === 'string' ? value : undefined
}

/** Parse a Host-header authority. */
function parseAuthority(authority) {
  try {
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

/** Whether a hostname names the local loopback authority. */
function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Canonical authority form used for a trusted-host comparison. */
function canonicalAuthority(entry, entryUrl) {
  const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port
  return port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`
}

/** Whether a request authority matches a configured trusted host. */
function isTrustedAuthority(hostUrl, trustedHosts) {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname ? entryUrl.hostname === hostUrl.hostname : entryUrl.host === hostUrl.host
  })
}

/**
 * Browser-trust fence for the route, behaviorally identical to the `/api`
 * gateway's fence: loopback or explicitly trusted Host, and same-origin
 * browser markers. This is a DNS-rebinding / cross-site defense, not
 * authentication.
 */
export function isTrustedApiRequest(request, trustedHosts) {
  const host = headerOf(request.headers, 'host')
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false
  if (headerOf(request.headers, 'sec-fetch-site') === 'cross-site') return false
  const origin = headerOf(request.headers, 'origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).hostname === hostUrl.hostname
  } catch {
    return false
  }
}

/* -------------------------------------------------------------------------- */
/* HTTP plumbing                                                              */
/* -------------------------------------------------------------------------- */

/** One typed route failure. */
class RouteError extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = 'SessionCleanerRouteError'
    this.status = status
    this.code = code
  }
}

/** Read and parse a bounded JSON body. */
async function readJsonBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new RouteError(413, 'payload-too-large', 'request body is too large')
    chunks.push(buffer)
  }
  if (size === 0) return {}
  let parsed
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new RouteError(400, 'bad-json', 'request body is not valid JSON')
  }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
}

/** Write one JSON response. */
function respondJson(response, status, value) {
  if (response.headersSent) return
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

/* -------------------------------------------------------------------------- */
/* Route                                                                      */
/* -------------------------------------------------------------------------- */

/** Read the authoritative archived id set. */
function archivedIds(ctx) {
  try {
    return [...ctx.workspaceRegistry.archivedSessionIds]
  } catch {
    return []
  }
}

/**
 * Build the JSON API handler over one Host context.
 *
 * @param {object} ctx - Host plugin context.
 * @returns {(request: object, response: object) => Promise<void>}
 */
function createRouteHandler(ctx) {
  const trustedHosts = ctx.get('webRuntime')?.trustedHosts ?? []
  return async function handleSessionCleanerRoute(request, response) {
    if (!isTrustedApiRequest(request, trustedHosts)) {
      respondJson(response, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
      return
    }
    if (request.method !== 'POST') {
      respondJson(response, 405, { ok: false, error: { code: 'method-not-allowed', message: 'POST required' } })
      return
    }
    let method = ''
    try {
      const pathname = new URL(request.url ?? '/', 'http://dsh.internal').pathname
      if (pathname.startsWith(ROUTE_PREFIX + '/')) method = pathname.slice(ROUTE_PREFIX.length + 1)
    } catch {
      method = ''
    }
    if (method === '' || method.includes('/')) {
      respondJson(response, 404, { ok: false, error: { code: 'not-found', message: 'unknown method' } })
      return
    }
    try {
      const input = await readJsonBody(request)
      if (method === 'status') {
        const pending = await readPending()
        let lastSweep = null
        try {
          lastSweep = JSON.parse(await readFile(LAST_SWEEP_FILE, 'utf8'))
        } catch {
          lastSweep = null
        }
        respondJson(response, 200, {
          ok: true,
          value: {
            archived: archivedIds(ctx),
            pending,
            lastSweep,
          },
        })
        return
      }
      if (method === 'probe') {
        const ids = Array.isArray(input.ids) ? input.ids : await readPending()
        const results = []
        for (const id of ids) results.push(await probeOne(ctx, id))
        respondJson(response, 200, { ok: true, value: { results } })
        return
      }
      if (method === 'sweep') {
        const outcome = await processPending(ctx)
        respondJson(response, 200, {
          ok: true,
          value: {
            ...outcome,
            archivedRemaining: archivedIds(ctx).length,
            pendingCount: (await readPending()).length,
          },
        })
        return
      }
      if (method === 'delete') {
        let ids
        if (input.scope === 'archived') {
          ids = archivedIds(ctx)
        } else if (Array.isArray(input.ids)) {
          if (input.ids.length > MAX_REQUEST_IDS) throw new RouteError(400, 'too-many-ids', 'too many Session ids')
          ids = input.ids
        } else {
          throw new RouteError(400, 'bad-request', 'either `ids` or `scope: "archived"` is required')
        }
        const options = {
          deferLive: input.deferLive === true,
          cascade: input.cascade !== false,
        }
        const results = await serialize(() => deleteMany(ctx, ids, options))
        const summary = summarize(results)
        respondJson(response, 200, {
          ok: true,
          value: {
            ...summary,
            archivedRemaining: archivedIds(ctx).length,
            pendingCount: (await readPending()).length,
          },
        })
        return
      }
      respondJson(response, 404, { ok: false, error: { code: 'not-found', message: `unknown method "${method}"` } })
    } catch (error) {
      const status = error instanceof RouteError ? error.status : 500
      const code = error instanceof RouteError ? error.code : 'internal'
      warn(ctx, 'route failure', error)
      respondJson(response, status, { ok: false, error: { code, message: messageOf(error) } })
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Plugin                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Mount the Host half: the HTTP route plus one boot-time pending sweep.
 *
 * @param {object} ctx - Cordis Host plugin context.
 * @param {object | undefined} config - optional storage-path overrides.
 */
export function apply(ctx, config) {
  configure(config)
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: createRouteHandler(ctx),
      }),
    'session-cleaner: /session-cleaner/api routes',
  )

  const timer = setTimeout(() => {
    processPending(ctx).catch((error) => warn(ctx, 'pending sweep', error))
  }, PENDING_SWEEP_DELAY_MS)
  if (typeof timer.unref === 'function') timer.unref()
  ctx.effect(
    () => () => {
      clearTimeout(timer)
    },
    'session-cleaner: pending sweep timer',
  )
}

/** Internals exposed for the Node smoke test (not part of the public surface). */
export const __internals = {
  DSH_HOME,
  SESSIONS_ROOT,
  PROJECTION_CACHE_ROOT,
  QUEUE_FILE,
  createRouteHandler,
  deleteMany,
  purgeRegistry,
  collectCascade,
  summarize,
  isTrustedApiRequest,
}
