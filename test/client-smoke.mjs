// Node smoke test for the browser half of dsh-session-cleaner.
//
// Loads the shipped client.js into a fake module loader, calls apply() on a
// fake Client context, server-renders the registered menu rows, row button and
// confirmation overlay, and drives the Host API calls (single, batch, error)
// without a browser.
//
//   node test/client-smoke.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import vm from 'node:vm'

const testRequire = createRequire('E:/dsh/_test/package.json')
const React = testRequire('react')
const { renderToStaticMarkup } = testRequire('react-dom/server')
const CLIENT = join(import.meta.dirname, '..', 'client.js')
const source = readFileSync(CLIENT, 'utf8')

const plain = (value) => JSON.parse(JSON.stringify(value))

// ---- fake module loader -----------------------------------------------------
let definition
const styleTags = []
const sandbox = {
  window: {
    __ModuleLoader__: {
      load(next) {
        definition = next
      },
    },
  },
  console,
  Math,
  Date,
  Intl,
  JSON,
  Promise,
  setTimeout,
  clearTimeout,
  fetch: undefined,
  document: {
    createElement: () => {
      const tag = { dataset: {}, textContent: '', remove() {} }
      styleTags.push(tag)
      return tag
    },
    head: { appendChild() {} },
    body: { appendChild() {} },
  },
}
vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: CLIENT })
assert.ok(definition, 'module loader received the definition')
assert.equal(definition.id, 'dsh-session-cleaner')

// The platform always supplies the shared primitives; use simple stubs so the
// assertions can read the rendered props without a DOM.
const menuItems = []
const modals = []
const primitivesStub = {
  MenuItemButton(props) {
    menuItems.push(props)
    return React.createElement(
      'button',
      { role: 'menuitem', 'data-danger': String(props.danger === true) },
      props.icon || null,
      React.createElement('span', null, props.children),
    )
  },
  Modal(props) {
    modals.push(props)
    if (!props.open) return null
    return React.createElement(
      'div',
      { role: 'dialog' },
      React.createElement('h2', null, props.title),
      props.description ? React.createElement('p', null, props.description) : null,
      props.children || null,
      props.footer || null,
    )
  },
  Tooltip(props) {
    return props.children
  },
}

const plugin = definition.factory((id) => {
  if (id === 'react') return React
  if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub
  throw new Error('unexpected require: ' + id)
})
assert.deepEqual(plain(plugin.inject), ['slots', 'locale', 'uiWorkspace', 'sessions'])
assert.equal(plugin.NS, 'sessionCleaner')

// ---- fake client context ----------------------------------------------------
function makeStore(initial) {
  let value = initial
  const listeners = new Set()
  return {
    getSnapshot: () => value,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set(next) {
      value = next
      for (const listener of [...listeners]) listener()
    },
  }
}

const workspaceStore = makeStore({
  phase: 'ready',
  items: [{ workspaceId: 'w1', path: 'E:\\dsh', sessionIds: ['s1', 's2', 's-current'] }],
  archivedSessionIds: ['s1', 's2'],
  pinnedSessionIds: [],
})
const sessionListStore = makeStore({
  phase: 'ready',
  ids: ['s-current', 's1', 's2'],
  byId: {
    's-current': { displayTitle: '当前会话' },
    s1: { displayTitle: '归档一' },
    s2: { displayTitle: '归档二' },
  },
})

const records = {
  registrations: [],
  starts: 0,
  refreshes: 0,
  fetchCalls: [],
  t: null,
}
let fetchImpl = async (url) => ({
  ok: true,
  status: 200,
  async json() {
    if (url.endsWith('/status')) {
      return { ok: true, value: { archived: ['s1', 's2'], pending: ['queued-1'] } }
    }
    return {
      ok: true,
      value: { deleted: ['s1'], deferred: [], active: [], missing: [], failed: [], archivedRemaining: 1, pendingCount: 1 },
    }
  },
})
sandbox.fetch = async (url, init) => {
  records.fetchCalls.push({ url, init })
  return fetchImpl(url, init)
}

const ctx = {
  effect(fn) {
    const dispose = fn()
    return () => {
      if (typeof dispose === 'function') dispose()
    }
  },
  locale: {
    register(namespace, dictionaries) {
      records.t = (key, params) => {
        const template = dictionaries.zh[key] ?? key
        return params ? template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match)) : template
      }
      return () => {}
    },
    bind() {
      return (key, params) => {
        const template = records.t ? records.t(key, params) : key
        return template
      }
    },
  },
  slots: {
    inject(key, callback) {
      const result = callback()
      if (result && typeof result.next === 'function') {
        let step = result.next()
        while (!step.done) step = result.next()
      }
    },
    register(options, component) {
      records.registrations.push({ options, component })
      return () => {}
    },
  },
  uiWorkspace: {
    workspaces: { list: workspaceStore },
    sessions: { list: sessionListStore },
    mainReference: { sessionId: 's-current' },
    startSession() {
      records.starts += 1
    },
  },
  sessions: {
    async refresh() {
      records.refreshes += 1
    },
  },
}

plugin.apply(ctx)
assert.ok(records.t, 'dictionary registered')
assert.ok(styleTags.length > 0, 'styles injected')

const byId = (id) => records.registrations.find((entry) => entry.options.id === id)
const menuDelete = byId('session-cleaner.delete-session')
const settingsSection = byId('archived-sessions')
const rowAction = records.registrations.find(
  (entry) => entry.options.name === 'sidebar.workspaces.session.row.action',
)
const overlay = byId('session-cleaner.overlay')
assert.ok(menuDelete, 'delete menu item registered')
assert.ok(settingsSection, 'settings section registered')
assert.ok(rowAction, 'row action registered')
assert.ok(overlay, 'overlay registered')
assert.equal(menuDelete.options.order, 500)
assert.equal(settingsSection.options.name, 'settings.section')
assert.equal(settingsSection.options.order, 40)
assert.equal(settingsSection.options.label(), '会话清理')
assert.equal(rowAction.options.order, 300)
assert.equal(
  records.registrations.some((entry) => entry.options.id === 'session-cleaner.purge-archived'),
  false,
  'the batch action is no longer a sidebar menu item',
)

// ---- inject faces -----------------------------------------------------------
const archivedSet = new Set(workspaceStore.getSnapshot().archivedSessionIds)
const menuDeleteFace = menuDelete.options.inject()
assert.equal(typeof menuDeleteFace.openSingleDelete, 'function')
assert.ok(menuDeleteFace.hooks.archived)

const settingsFace = settingsSection.options.inject()
assert.ok(settingsFace.hooks.archivedInfo)
assert.ok(settingsFace.hooks.cleanerStatus)
assert.equal(typeof settingsFace.openPurge, 'function')
assert.equal(typeof settingsFace.refreshStatus, 'function')
assert.equal(settingsFace.hooks.archivedInfo.getSnapshot().count, 2)
assert.deepEqual(
  settingsFace.hooks.archivedInfo.getSnapshot().rows.map((row) => row.title),
  ['归档一', '归档二'],
)

// ---- render the menu rows and row button -----------------------------------
const t = records.t
let html = renderToStaticMarkup(
  React.createElement(menuDelete.component, {
    sessionId: 's1',
    displayTitle: '归档一',
    useArchived: (selector) => selector(archivedSet),
    useMenuOpenState: () => [true, () => {}],
    openSingleDelete: menuDeleteFace.openSingleDelete,
    t,
  }),
)
assert.ok(html.includes('彻底删除会话'), 'archived rows use the permanent-delete label')
assert.ok(html.includes('data-danger="true"'), 'delete row is destructive')

const renderSettings = () =>
  renderToStaticMarkup(
    React.createElement(settingsSection.component, {
      useArchivedInfo: (selector) => selector(settingsFace.hooks.archivedInfo.getSnapshot()),
      useCleanerStatus: (selector) => selector(settingsFace.hooks.cleanerStatus.getSnapshot()),
      openPurge: settingsFace.openPurge,
      refreshStatus: settingsFace.refreshStatus,
      t,
    }),
  )

html = renderSettings()
assert.ok(html.includes('会话清理'), 'settings section title')
assert.ok(html.includes('共 2 个已归档会话'), 'settings section shows the archived count')
assert.ok(html.includes('删除全部已归档（2）…'), 'settings section owns the batch action')
assert.ok(html.includes('单个会话的删除入口'), 'settings section points at the row menu')

// The status read fills the pending-queue line.
await settingsFace.refreshStatus()
assert.equal(settingsFace.hooks.cleanerStatus.getSnapshot().phase, 'ready')
assert.equal(settingsFace.hooks.cleanerStatus.getSnapshot().pending, 1)
html = renderSettings()
assert.ok(html.includes('1 个会话暂时无法删除，已安排在下次启动时重试'), 'settings section shows the pending queue')

html = renderToStaticMarkup(
  React.createElement(rowAction.component, {
    sessionId: 's2',
    displayTitle: '归档二',
    openSingleDelete: menuDeleteFace.openSingleDelete,
    t,
  }),
)
assert.ok(html.includes('aria-label="删除会话"'), 'hover button exposes an accessible label')

// ---- dialog rendering -------------------------------------------------------
const overlayFace = overlay.options.inject()
const renderOverlay = () =>
  renderToStaticMarkup(
    React.createElement(overlay.component, {
      useCleanerRequest: (selector) => selector(overlayFace.hooks.cleanerRequest.getSnapshot()),
      useCleanerToast: (selector) => selector(overlayFace.hooks.cleanerToast.getSnapshot()),
      confirmDelete: overlayFace.confirmDelete,
      closeDialog: overlayFace.closeDialog,
      clearToast: overlayFace.clearToast,
      t,
    }),
  )

assert.equal(renderOverlay(), '', 'no dialog while idle')

menuDeleteFace.openSingleDelete('s2', '归档二', true)
html = renderOverlay()
assert.ok(html.includes('永久删除这个会话？'), 'single dialog title')
assert.ok(html.includes('归档二'), 'single dialog names the conversation')
assert.ok(html.includes('永久删除'), 'confirm button')
assert.ok(html.includes('取消'), 'cancel button')

overlayFace.closeDialog()
assert.equal(renderOverlay(), '', 'cancel closes the dialog')

// ---- batch dialog (opened from Settings) -----------------------------------
settingsFace.openPurge(settingsFace.hooks.archivedInfo.getSnapshot())
html = renderOverlay()
assert.ok(html.includes('删除全部已归档会话？'), 'batch dialog title')
assert.ok(html.includes('将永久删除 2 个已归档会话'), 'batch dialog counts')
assert.ok(html.includes('归档一'), 'batch dialog lists titles')

// ---- confirm a batch request -----------------------------------------------
const deletesBefore = records.fetchCalls.filter((call) => call.url.endsWith('/delete')).length
await overlayFace.confirmDelete(overlayFace.hooks.cleanerRequest.getSnapshot())
const deleteCalls = records.fetchCalls.filter((call) => call.url.endsWith('/delete'))
assert.equal(deleteCalls.length, deletesBefore + 1)
const batchCall = deleteCalls[deleteCalls.length - 1]
assert.equal(batchCall.url, '/session-cleaner/api/delete')
assert.deepEqual(JSON.parse(batchCall.init.body), { scope: 'archived', deferLive: false })
assert.equal(
  records.fetchCalls.filter((call) => call.url.endsWith('/status')).length,
  2,
  'status read on mount-equivalent and after the deletion',
)
assert.equal(records.refreshes, 1, 'session list refreshed')
assert.equal(overlayFace.hooks.cleanerRequest.getSnapshot(), null, 'dialog closed after success')
const toast = overlayFace.hooks.cleanerToast.getSnapshot()
assert.ok(toast && toast.parts.length > 0, 'result toast set')
html = renderOverlay()
assert.ok(html.includes('已永久删除 1 个会话'), 'toast renders deleted count')
assert.equal(modals.length, 2, 'modal primitive used for both dialogs')

// ---- single request for the current conversation navigates away first -----
menuDeleteFace.openSingleDelete('s-current', '当前会话', false)
await overlayFace.confirmDelete(overlayFace.hooks.cleanerRequest.getSnapshot())
assert.equal(records.starts, 1, 'startSession called for the open conversation')
const singleCall = records.fetchCalls.filter((call) => call.url.endsWith('/delete')).at(-1)
assert.deepEqual(JSON.parse(singleCall.init.body), { ids: ['s-current'], deferLive: false })

// ---- error path keeps the dialog open with a message ----------------------
fetchImpl = async () => ({
  ok: false,
  status: 500,
  async json() {
    return { ok: false, error: { code: 'internal', message: 'boom' } }
  },
})
menuDeleteFace.openSingleDelete('s1', '归档一', true)
await overlayFace.confirmDelete(overlayFace.hooks.cleanerRequest.getSnapshot())
const failed = overlayFace.hooks.cleanerRequest.getSnapshot()
assert.equal(failed.busy, false)
assert.equal(failed.errorCode, 'request')
assert.equal(failed.errorDetail, 'boom')
html = renderOverlay()
assert.ok(html.includes('删除请求失败：boom'), 'error message rendered')

// ---- missing Host route -----------------------------------------------------
fetchImpl = async () => ({
  ok: false,
  status: 404,
  async json() {
    return { ok: false, error: { code: 'not-found', message: 'unknown method' } }
  },
})
await overlayFace.confirmDelete(overlayFace.hooks.cleanerRequest.getSnapshot())
assert.equal(overlayFace.hooks.cleanerRequest.getSnapshot().errorCode, 'host')
html = renderOverlay()
assert.ok(html.includes('会话清理服务未加载'), 'host-missing message rendered')

console.log('client-smoke: PASS')
