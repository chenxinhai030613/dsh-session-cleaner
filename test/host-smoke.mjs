// Node smoke test for the Host half of dsh-session-cleaner.
//
// Runs the real index.js against a temporary $DSH_HOME and fake Cordis
// services, exercising the fenced HTTP route, single/batch deletion, cascade
// cleanup, deferred live sessions, active-work refusal and the boot sweep.
//
//   node test/host-smoke.mjs
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const PLUGIN_DIR = join(import.meta.dirname, '..')
const ROOT = join(PLUGIN_DIR, '.test-tmp', 'host-' + Date.now().toString(36))
const HOME = join(ROOT, 'home')
const SESSIONS = join(HOME, 'sessions', '--E-test--')
const CACHE = join(HOME, 'storages', 'session_projcache', 'sessions')
const PLUGIN_URL = pathToFileURL(join(PLUGIN_DIR, 'index.js')).href + '?t=' + Date.now().toString(36)

process.env.DSH_HOME = HOME

async function makeSession(id) {
  const dir = join(SESSIONS, id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session.v4.jsonl.zstd'), Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))
  return dir
}

await mkdir(SESSIONS, { recursive: true })
await mkdir(CACHE, { recursive: true })
const alphaDir = await makeSession('session-alpha')
const childDir = await makeSession('session-child')
const liveDir = await makeSession('session-live')
const activeDir = await makeSession('session-active')
await writeFile(join(CACHE, 'session-alpha.json'), '{}')
await writeFile(join(CACHE, 'session-child.json'), '{}')
await writeFile(join(CACHE, 'session-ghost.json'), '{}')

const plugin = await import(PLUGIN_URL)
assert.equal(plugin.name, 'dsh-session-cleaner')

// ---- fake Cordis host ------------------------------------------------------
const records = {
  routes: [],
  effects: [],
  detached: [],
  detachedSessions: [],
  detachedAgents: [],
  unarchived: [],
  queued: [],
  warnings: [],
}
let archived = ['session-alpha', 'session-child', 'session-ghost']
const liveIds = new Set(['session-live'])
const agentRegistry = {
  store: new Map([['session-live', { id: 'session-live', agent: { id: 'session-live' } }]]),
  get(id) {
    return this.store.get(id)?.agent
  },
  detachEntered(entry) {
    this.store.delete(entry.id)
    records.detachedAgents.push(entry.id)
  },
}
const activeIds = new Set(['session-active'])
const storedHeaders = [
  { id: 'session-alpha', cwd: 'E:\\test', isSeeded: false },
  { id: 'session-child', cwd: 'E:\\test', isSeeded: true, parentSession: 'session-alpha', origin: 'subagent' },
  { id: 'session-live', cwd: 'E:\\test', isSeeded: false },
  { id: 'session-active', cwd: 'E:\\test', isSeeded: false },
]

const ctx = {
  get(service) {
    if (service === 'webRuntime') return { trustedHosts: [] }
    if (service === 'agents') return agentRegistry
    return undefined
  },
  effect(fn) {
    records.effects.push(fn)
    return fn()
  },
  logger: { warn: (line) => records.warnings.push(String(line)) },
  webServer: {
    register(route) {
      records.routes.push(route)
      return () => {}
    },
  },
  sessions: {
    get: (id) => (liveIds.has(id) ? { id } : undefined),
    liveEntryFor: (session) => ({ id: session.id, session }),
    detachEntered: (entry) => {
      liveIds.delete(entry.id)
      records.detachedSessions.push(entry.id)
    },
  },
  sessionPersistence: {
    async stat(id) {
      if (!existsSync(join(SESSIONS, id))) throw new Error('ENOENT')
      return { header: { id } }
    },
    async list() {
      return storedHeaders
        .filter((header) => existsSync(join(SESSIONS, header.id)))
        .map((header) => ({ header }))
    },
  },
  workspaceRegistry: {
    get archivedSessionIds() {
      return archived
    },
    async unarchiveSession(id) {
      records.unarchived.push(id)
      archived = archived.filter((entry) => entry !== id)
    },
    async unpinSession() {},
    list() {
      return [
        {
          sessionIds: ['session-alpha', 'session-child', 'session-live'],
          async detachSession(id) {
            records.detached.push(id)
          },
        },
      ]
    },
  },
  async waterfall(event, payload) {
    if (payload && activeIds.has(payload.sessionId)) return [{ kind: 'turn' }]
    return []
  },
  async parallel() {},
}

plugin.apply(ctx)
assert.equal(records.routes.length, 1, 'one route registered')
const route = records.routes[0]
assert.equal(route.kind, 'prefix')
assert.equal(route.path, '/session-cleaner/api')

// ---- fake HTTP -------------------------------------------------------------
function makeHeaders(extra = {}) {
  return { host: '127.0.0.1:54213', 'sec-fetch-site': 'same-origin', origin: 'http://127.0.0.1:54213', ...extra }
}

async function call(method, payload, headers = makeHeaders(), requestMethod = 'POST') {
  const body = payload === undefined ? [] : [Buffer.from(JSON.stringify(payload))]
  const request = {
    method: requestMethod,
    url: '/session-cleaner/api/' + method,
    headers,
    async *[Symbol.asyncIterator]() {
      for (const chunk of body) yield chunk
    },
  }
  let status = 0
  let text = ''
  const response = {
    headersSent: false,
    writeHead(code) {
      status = code
    },
    end(chunk) {
      text = chunk === undefined ? '' : String(chunk)
    },
  }
  await route.handler(request, response)
  return { status, body: text === '' ? null : JSON.parse(text) }
}

// ---- fence ------------------------------------------------------------------
let result = await call('status', {}, makeHeaders({ 'sec-fetch-site': 'cross-site' }))
assert.equal(result.status, 403, 'cross-site refused')
result = await call('status', {}, makeHeaders({ host: 'evil.example' }))
assert.equal(result.status, 403, 'foreign host refused')
result = await call('status', {}, makeHeaders(), 'GET')
assert.equal(result.status, 405, 'GET refused')
result = await call('nope', {})
assert.equal(result.status, 404, 'unknown method')

// ---- status -----------------------------------------------------------------
result = await call('status', {})
assert.equal(result.status, 200)
assert.deepEqual(result.body.value.archived, ['session-alpha', 'session-child', 'session-ghost'])
assert.deepEqual(result.body.value.pending, [])

// ---- single deletion + cascade ---------------------------------------------
result = await call('delete', { ids: ['session-alpha'], deferLive: true })
assert.equal(result.status, 200)
assert.deepEqual(result.body.value.deleted, ['session-alpha', 'session-child'])
assert.ok(!existsSync(alphaDir), 'alpha log directory removed')
assert.ok(!existsSync(childDir), 'subagent child cascaded')
assert.ok(!existsSync(join(CACHE, 'session-alpha.json')), 'alpha projection cache removed')
assert.ok(!existsSync(join(CACHE, 'session-child.json')), 'child projection cache removed')
assert.ok(records.detached.includes('session-alpha'), 'workspace accounting detached')
assert.ok(records.unarchived.includes('session-alpha'), 'archive reference removed')
assert.equal(archived.includes('session-alpha'), false)

// ---- live Session with deferLive keeps the queue-for-next-boot behavior ----
result = await call('delete', { ids: ['session-live'], deferLive: true })
assert.deepEqual(result.body.value.deferred, ['session-live'])
assert.ok(existsSync(liveDir), 'deferred live log untouched')
const pendingFile = join(HOME, 'session-cleaner', 'pending.json')
let queued = JSON.parse(await readFile(pendingFile, 'utf8'))
assert.deepEqual(queued.ids, ['session-live'], 'pending queue written')

// ---- an idle live Session is force-detached and deleted immediately --------
result = await call('delete', { ids: ['session-live'] })
assert.deepEqual(result.body.value.deleted, ['session-live'])
assert.equal(liveIds.has('session-live'), false, 'live session detached')
assert.ok(records.detachedSessions.includes('session-live'), 'session store detach used')
assert.ok(records.detachedAgents.includes('session-live'), 'agent registry detach used')
assert.ok(!existsSync(liveDir), 'force-detached log deleted')
assert.equal(existsSync(pendingFile), false, 'settled id removed from the pending queue')

// ---- probe reports deletability facts without mutating ---------------------
result = await call('probe', { ids: ['session-active'] })
const probe = result.body.value.results[0]
assert.equal(probe.id, 'session-active')
assert.equal(probe.activity, 1)
assert.equal(probe.canDetach, true)

// ---- running work is refused ------------------------------------------------
result = await call('delete', { ids: ['session-active'], deferLive: true })
assert.equal(result.body.value.active[0], 'session-active')
assert.ok(existsSync(activeDir), 'active log untouched')

// ---- batch archived delete --------------------------------------------------
result = await call('delete', { scope: 'archived' })
assert.equal(result.status, 200)
assert.equal(result.body.value.archivedRemaining, 0)
assert.equal(result.body.value.pendingCount, 0)
assert.ok(result.body.value.missing.includes('session-ghost'))
assert.ok(!existsSync(join(CACHE, 'session-ghost.json')), 'stale ghost cache removed')

// ---- boot sweep still deletes a queued Session -----------------------------
const sweepDir = await makeSession('session-sweep')
storedHeaders.push({ id: 'session-sweep', cwd: 'E:\\test', isSeeded: false })
liveIds.add('session-sweep')
result = await call('delete', { ids: ['session-sweep'], deferLive: true })
assert.deepEqual(result.body.value.deferred, ['session-sweep'])
liveIds.clear()
const sweep = await plugin.processPending(ctx)
assert.ok(sweep.swept.includes('session-sweep'))
assert.ok(!existsSync(sweepDir), 'queued log deleted by sweep')
assert.equal(existsSync(pendingFile), false, 'queue cleared')

// ---- cascade over the whole tree ------------------------------------------
await makeSession('session-parent')
await makeSession('session-kid')
storedHeaders.push({ id: 'session-parent', cwd: 'E:\\test', isSeeded: false })
storedHeaders.push({ id: 'session-kid', cwd: 'E:\\test', isSeeded: true, parentSession: 'session-parent', origin: 'subagent' })
const expanded = await plugin.__internals.collectCascade(ctx, ['session-parent'])
assert.ok(expanded.includes('session-kid'))

// ---- done -------------------------------------------------------------------
for (const effect of records.effects) {
  try {
    const dispose = effect()
    if (typeof dispose === 'function') dispose()
  } catch {}
}
await rm(ROOT, { recursive: true, force: true })
console.log('host-smoke: PASS')
