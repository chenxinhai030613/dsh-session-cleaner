/**
 * Browser half of the `dsh-session-cleaner` bundle.
 *
 * Adds the deletion affordances DeepSeek Harness itself does not ship:
 *
 * - a "delete conversation" item (and hover trash button) on every Session
 *   row, archived or not, with a destructive confirmation dialog;
 * - a "delete all archived conversations" item that appears whenever the
 *   archive set is non-empty, on any Session row menu;
 * - a shared confirmation overlay that reports what was deleted, what was
 *   deferred because the Session is still live in this Host process, and what
 *   was refused because it still has running work.
 *
 * Everything destructive happens in the Host half; this half only collects
 * intent, confirms it, and refreshes the client Session list afterwards.
 *
 * @module dsh-session-cleaner/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-session-cleaner',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Optional shared UI primitives; the platform exposes them to every loader bundle. */
    const primitives = (() => {
      try {
        return require('@deepseek-ai/dsh-client-ui-primitives')
      } catch (_error) {
        return null
      }
    })()

    /** Dictionary namespace owned by this plugin. */
    const NS = 'sessionCleaner'

    /** Cordis Client services required by this half. */
    const inject = ['slots', 'locale', 'uiWorkspace', 'sessions']

    /** Route prefix of the Host half. */
    const API_PREFIX = '/session-cleaner/api'

    /** How long to wait after navigating away before asking the Host to delete. */
    const NAVIGATION_SETTLE_MS = 500

    /** How long one result toast stays on screen. */
    const TOAST_MS = 7000

    /* ------------------------------------------------------------------ */
    /* Dictionary                                                          */
    /* ------------------------------------------------------------------ */

    /** Simplified Chinese (key-set source of truth). */
    const zh = {
      'menu.deleteSession': '删除会话…',
      'menu.deleteArchived': '彻底删除会话…',
      'actions.delete': '删除会话',
      'settings.nav': '会话清理',
      'settings.title': '会话清理',
      'settings.intro': '管理本机的会话数据：删除单个会话，或一次清理全部已归档会话。',
      'settings.archivedTitle': '已归档会话',
      'settings.archivedDesc': '共 {count} 个已归档会话；删除会清除它们的本地日志、投影缓存与归档记录。',
      'settings.purgeAction': '删除全部已归档（{count}）…',
      'settings.empty': '当前没有已归档会话。',
      'settings.hint': '单个会话的删除入口在会话行的“…”菜单里。',
      'settings.pending': '{count} 个会话暂时无法删除，已安排在下次启动时重试。',
      'settings.liveNote': '打开但没有运行工作的会话会先释放再立即删除；正在运行的会话不会被删除。',
      'settings.refresh': '刷新',
      'settings.loading': '正在读取清理状态…',
      'settings.error': '无法读取清理状态：{message}',
      'dialog.deleteTitle': '永久删除这个会话？',
      'dialog.deleteDesc': '“{title}”将从本机删除，归档中的会话同样适用。',
      'dialog.deleteBody': '会删除该会话的本地日志、投影缓存与侧栏记录；它的子代理会话会一并删除。',
      'dialog.deleteCurrent': '这个会话当前正在显示：会先切换到新会话，再执行删除。',
      'dialog.deleteWarn': '此操作无法撤销。',
      'dialog.purgeTitle': '删除全部已归档会话？',
      'dialog.purgeDesc': '将永久删除 {count} 个已归档会话。',
      'dialog.purgeBody': '这些会话的本地日志、投影缓存与归档记录都会被清除；普通（未归档）会话不受影响。',
      'dialog.purgeMore': '……以及另外 {count} 个会话',
      'dialog.purgeLive': '仍在本应用中打开但没有运行工作的会话会先释放再立即删除；正在运行的会话不会被删除。',
      'dialog.untitled': '未命名会话',
      'dialog.error': '删除失败：{message}',
      'dialog.cancel': '取消',
      'dialog.confirmDelete': '永久删除',
      'dialog.confirmPurge': '删除全部',
      'dialog.busy': '正在删除…',
      'toast.deleted': '已永久删除 {count} 个会话',
      'toast.deferred': '{count} 个会话正在使用中，已安排在下次启动时删除',
      'toast.active': '{count} 个会话仍在运行，未删除',
      'toast.live': '{count} 个会话仍被当前进程占用，未能删除',
      'toast.missing': '{count} 个会话仅有残留引用被清理',
      'toast.failed': '{count} 个会话删除失败',
      'toast.none': '没有可删除的会话',
      'error.host': '会话清理服务未加载，无法删除。',
      'error.request': '删除请求失败：{message}',
    }

    /** English dictionary, checked complete against the zh key set. */
    const en = {
      'menu.deleteSession': 'Delete conversation…',
      'menu.deleteArchived': 'Permanently delete conversation…',
      'actions.delete': 'Delete conversation',
      'settings.nav': 'Conversation cleanup',
      'settings.title': 'Conversation cleanup',
      'settings.intro': 'Manage conversation data on this machine: delete one conversation, or clean up every archived conversation at once.',
      'settings.archivedTitle': 'Archived conversations',
      'settings.archivedDesc': '{count} archived conversations; deleting them removes their local logs, projection caches and archive records.',
      'settings.purgeAction': 'Delete all archived ({count})…',
      'settings.empty': 'There are no archived conversations right now.',
      'settings.hint': 'To delete a single conversation, use the “…” menu on its row.',
      'settings.pending': '{count} conversations cannot be deleted right now and are queued for a retry at the next start.',
      'settings.liveNote': 'Conversations that are open but idle are released and deleted immediately; conversations with running work are not deleted.',
      'settings.refresh': 'Refresh',
      'settings.loading': 'Reading cleanup status…',
      'settings.error': 'Could not read cleanup status: {message}',
      'dialog.deleteTitle': 'Permanently delete this conversation?',
      'dialog.deleteDesc': '“{title}” will be removed from this machine, including when it is archived.',
      'dialog.deleteBody': 'Its local log, projection cache and sidebar records are removed; its subagent conversations are removed with it.',
      'dialog.deleteCurrent': 'This conversation is currently open: a new conversation is opened first, then the deletion runs.',
      'dialog.deleteWarn': 'This cannot be undone.',
      'dialog.purgeTitle': 'Delete every archived conversation?',
      'dialog.purgeDesc': '{count} archived conversations will be permanently deleted.',
      'dialog.purgeBody': 'Their local logs, projection caches and archive records are removed; ordinary (unarchived) conversations are untouched.',
      'dialog.purgeMore': '…and {count} more conversations',
      'dialog.purgeLive': 'Conversations that are open in this application but idle are released and deleted immediately; conversations with running work are not deleted.',
      'dialog.untitled': 'Untitled conversation',
      'dialog.error': 'Deletion failed: {message}',
      'dialog.cancel': 'Cancel',
      'dialog.confirmDelete': 'Delete permanently',
      'dialog.confirmPurge': 'Delete all',
      'dialog.busy': 'Deleting…',
      'toast.deleted': 'Permanently deleted {count} conversations',
      'toast.deferred': '{count} conversations are in use and will be deleted at the next start',
      'toast.active': '{count} conversations still have running work and were not deleted',
      'toast.live': '{count} conversations are still held by the current process and could not be deleted',
      'toast.missing': '{count} conversations only had stale references cleaned up',
      'toast.failed': '{count} conversations could not be deleted',
      'toast.none': 'Nothing to delete',
      'error.host': 'The session cleaner service is not loaded, so nothing can be deleted.',
      'error.request': 'Deletion request failed: {message}',
    }

    /* ------------------------------------------------------------------ */
    /* Styles                                                             */
    /* ------------------------------------------------------------------ */

    const CSS = `
.dshSessionCleaner_rowAction{box-sizing:border-box;width:24px;height:24px;padding:0;border:none;background:0 0;border-radius:var(--dsw-radius-sm,6px);color:var(--dsw-alias-label-tertiary);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;flex:none}
.dshSessionCleaner_rowAction:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-state-error-primary)}
.dshSessionCleaner_rowAction:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dshSessionCleaner_rowAction:disabled{opacity:.4;cursor:default}
.dshSessionCleaner_menuFallback{display:flex;width:100%;box-sizing:border-box;align-items:center;gap:8px;padding:7px 10px;border:none;border-radius:var(--dsw-radius-sm,6px);background:0 0;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;text-align:left;cursor:pointer}
.dshSessionCleaner_menuFallback:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dshSessionCleaner_menuDanger{color:var(--dsw-alias-state-error-primary)}
.dshSessionCleaner_separator{height:1px;margin:4px 6px;background:var(--dsw-alias-border-l1)}
.dshSessionCleaner_body{display:flex;flex-direction:column;gap:10px;max-height:46vh;overflow:auto}
.dshSessionCleaner_text{margin:0;color:var(--dsw-alias-label-secondary);font-size:var(--dsh-content-font-size-secondary,13px);line-height:20px}
.dshSessionCleaner_list{margin:0;padding-left:18px;color:var(--dsw-alias-label-secondary);font-size:var(--dsh-content-font-size-secondary,13px);line-height:20px}
.dshSessionCleaner_note{color:var(--dsw-alias-label-tertiary);font-size:var(--dsh-content-font-size-secondary,13px);line-height:20px}
.dshSessionCleaner_error{margin:0;padding:8px 10px;border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-state-error-secondary,rgba(220,60,60,.12));color:var(--dsw-alias-state-error-primary);font-size:var(--dsh-content-font-size-secondary,13px);line-height:20px;word-break:break-word}
.dshSessionCleaner_buttons{display:flex;align-items:center;justify-content:flex-end;gap:10px}
.dshSessionCleaner_btn{box-sizing:border-box;height:34px;padding:0 16px;border-radius:var(--dsw-radius-md,8px);border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:var(--dsh-content-font-size-secondary,13px);line-height:20px;cursor:pointer}
.dshSessionCleaner_btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dshSessionCleaner_btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dshSessionCleaner_btn:disabled{opacity:.55;cursor:default}
.dshSessionCleaner_btnDanger{border-color:transparent;background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-primary-foreground,#fff);font-weight:500}
.dshSessionCleaner_btnDanger:hover:not(:disabled){background:var(--dsw-alias-state-error-primary);filter:brightness(1.06)}
.dshSessionCleaner_toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:1400;box-sizing:border-box;max-width:min(560px,calc(100vw - 48px));padding:10px 14px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-overlay);box-shadow:0 12px 36px rgba(0,0,0,.18);color:var(--dsw-alias-label-secondary);font-size:var(--dsh-content-font-size-secondary,13px);line-height:19px;pointer-events:none}
.dshSessionCleaner_toastWarn{color:var(--dsw-alias-label-primary)}
.dshSessionCleaner_toastError{color:var(--dsw-alias-state-error-primary)}
.dshSessionCleaner_settings{display:flex;flex-direction:column;gap:14px;max-width:760px;color:var(--dsw-alias-label-primary)}
.dshSessionCleaner_settingsTitle{margin:0;font-size:18px;line-height:26px;font-weight:600}
.dshSessionCleaner_settingsIntro{margin:0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}
.dshSessionCleaner_card{display:flex;flex-direction:column;gap:12px;padding:14px 16px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-layer-2,transparent)}
.dshSessionCleaner_cardRow{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
.dshSessionCleaner_cardTitle{margin:0;font-size:14px;line-height:21px;font-weight:500}
.dshSessionCleaner_cardDesc{margin:4px 0 0;color:var(--dsw-alias-label-tertiary);font-size:12.5px;line-height:19px}
.dshSessionCleaner_count{font-size:22px;line-height:28px;font-weight:600;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
.dshSessionCleaner_settingsNote{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12.5px;line-height:19px}
.dshSessionCleaner_cardActions{display:flex;align-items:center;justify-content:flex-end;gap:10px}
.dshSessionCleaner_btnSmall{height:30px;padding:0 12px;font-size:12.5px}
.dshSessionCleaner_btnGhost{border-color:transparent;background:transparent;color:var(--dsw-alias-label-tertiary);height:26px;padding:0 8px}
.dshSessionCleaner_btnGhost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary)}
.dshSessionCleaner_backdrop{position:fixed;inset:0;z-index:1350;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.32)}
.dshSessionCleaner_modal{box-sizing:border-box;width:min(520px,calc(100vw - 48px));max-height:min(640px,calc(100vh - 48px));display:flex;flex-direction:column;border-radius:var(--dsw-radius-xl,16px);background:var(--dsw-alias-bg-overlay);box-shadow:0 24px 64px rgba(0,0,0,.28);color:var(--dsw-alias-label-primary)}
.dshSessionCleaner_header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:18px 20px 8px}
.dshSessionCleaner_title{margin:0;font-size:15px;line-height:22px;font-weight:600}
.dshSessionCleaner_close{width:28px;height:28px;border:none;border-radius:var(--dsw-radius-sm,6px);background:0 0;color:var(--dsw-alias-label-tertiary);font-size:20px;line-height:1;cursor:pointer}
.dshSessionCleaner_close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dshSessionCleaner_content{padding:0 20px 4px;overflow:auto}
.dshSessionCleaner_footer{padding:10px 20px 18px}
@media (prefers-reduced-motion:reduce){.dshSessionCleaner_btn,.dshSessionCleaner_rowAction{transition:none}}
`

    /* ------------------------------------------------------------------ */
    /* Utilities                                                          */
    /* ------------------------------------------------------------------ */

    /** One tiny observable store; the slot `hooks` API consumes this shape. */
    function createStore(initial) {
      let state = initial
      const listeners = new Set()
      return {
        getSnapshot: () => state,
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        set(next) {
          state = next
          for (const listener of [...listeners]) listener()
        },
      }
    }

    /**
     * Derive one store from other stores, like the shipped sidebar's own
     * `derive`: the projection is recomputed lazily whenever a source snapshot
     * changes identity, so a baseline that arrives before the first subscriber
     * is never served stale.
     * @param {object[]} sources - stores with `getSnapshot`/`subscribe`.
     * @param {() => unknown} project - selector.
     * @returns {{getSnapshot: () => unknown, subscribe: (listener: () => void) => (() => void)}}
     */
    function derive(sources, project) {
      let initialized = false
      let seen = []
      let value
      return {
        getSnapshot() {
          const snapshots = sources.map((source) => source.getSnapshot())
          if (!initialized || snapshots.some((snapshot, index) => snapshot !== seen[index])) {
            initialized = true
            seen = snapshots
            value = project()
          }
          return value
        },
        subscribe(listener) {
          const disposers = sources.map((source) => source.subscribe(listener))
          return () => {
            for (const dispose of disposers) dispose()
          }
        },
      }
    }

    /** Browser sleep helper. */
    function delay(ms) {
      return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
    }

    /** One short message from an unknown rejection. */
    function messageOf(error) {
      return error instanceof Error ? error.message : String(error)
    }

    /** The Session described by the main view, when the client service exposes it. */
    function currentSessionId(ctx) {
      try {
        const reference = ctx.uiWorkspace && ctx.uiWorkspace.mainReference
        return reference && typeof reference.sessionId === 'string' ? reference.sessionId : undefined
      } catch (_error) {
        return undefined
      }
    }

    /* ------------------------------------------------------------------ */
    /* Host API                                                           */
    /* ------------------------------------------------------------------ */

    /**
     * Call one method of the Host half.
     * @param {string} method - `status` or `delete`.
     * @param {object} payload - JSON payload.
     * @returns {Promise<object>} the unwrapped value.
     */
    async function callApi(method, payload) {
      let response
      try {
        response = await fetch(API_PREFIX + '/' + method, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload === undefined ? {} : payload),
        })
      } catch (error) {
        throw new Error(messageOf(error))
      }
      let parsed = null
      try {
        parsed = await response.json()
      } catch (_error) {
        parsed = null
      }
      if (!response.ok || parsed === null || parsed.ok !== true) {
        const detail = parsed && parsed.error ? parsed.error : null
        if (detail && detail.code === 'not-found') throw new Error('host')
        throw new Error(detail && detail.message ? detail.message : 'HTTP ' + response.status)
      }
      return parsed.value
    }

    /* ------------------------------------------------------------------ */
    /* Shared UI primitives (with browser-safe fallbacks)                  */
    /* ------------------------------------------------------------------ */

    /** Trash glyph used by the row button; always available. */
    function TrashIcon({ size = 14 }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('path', {
          d: 'M3.2 4.4h9.6M6.2 4.4V3.2c0-.44.36-.8.8-.8h2c.44 0 .8.36.8.8v1.2M4.4 4.4l.55 8.05c.03.45.4.8.85.8h4.4c.45 0 .82-.35.85-.8L11.6 4.4M6.6 6.7v3.9M9.4 6.7v3.9',
          stroke: 'currentColor',
          strokeWidth: 1.35,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    /** Fallback menu row for a deployment without the shared primitives. */
    function FallbackMenuItemButton({ children, icon, danger, separatorBefore, onSelect, disabled }) {
      return h(
        'div',
        null,
        separatorBefore ? h('div', { className: 'dshSessionCleaner_separator', role: 'separator' }) : null,
        h(
          'button',
          {
            type: 'button',
            role: 'menuitem',
            disabled,
            className:
              'dshSessionCleaner_menuFallback' + (danger === true ? ' dshSessionCleaner_menuDanger' : ''),
            onClick: onSelect,
          },
          icon === undefined ? null : icon,
          h('span', null, children),
        ),
      )
    }

    const MenuItemButton =
      primitives && typeof primitives.MenuItemButton === 'function' ? primitives.MenuItemButton : FallbackMenuItemButton

    /** Fallback tooltip wrapper: renders its child untouched. */
    function FallbackTooltip({ children }) {
      return children
    }

    const Tooltip = primitives && typeof primitives.Tooltip === 'function' ? primitives.Tooltip : FallbackTooltip

    /** Fallback dialog shell used only if the shared Modal primitive is missing. */
    function FallbackModal({ open, title, closeLabel, onClose, children, footer }) {
      if (!open) return null
      return h(
        'div',
        { className: 'dshSessionCleaner_backdrop', role: 'presentation' },
        h(
          'div',
          {
            className: 'dshSessionCleaner_modal',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': title,
          },
          h(
            'div',
            { className: 'dshSessionCleaner_header' },
            h('h2', { className: 'dshSessionCleaner_title' }, title),
            h(
              'button',
              {
                type: 'button',
                className: 'dshSessionCleaner_close',
                'aria-label': closeLabel,
                onClick: onClose,
              },
              '×',
            ),
          ),
          h('div', { className: 'dshSessionCleaner_content' }, children),
          h('div', { className: 'dshSessionCleaner_footer' }, footer),
        ),
      )
    }

    const Modal = primitives && typeof primitives.Modal === 'function' ? primitives.Modal : FallbackModal

    /* ------------------------------------------------------------------ */
    /* Components                                                         */
    /* ------------------------------------------------------------------ */

    /**
     * Session-row menu row: delete this conversation.
     * @param {object} props - row identity, archive hook, menu hook and callbacks.
     * @returns {object} the menu row.
     */
    function DeleteSessionMenuItem(props) {
      const { sessionId, displayTitle, useArchived, useMenuOpenState, openSingleDelete, t } = props
      const archived = typeof useArchived === 'function' ? useArchived((set) => set.has(sessionId)) : false
      const closeMenu = typeof useMenuOpenState === 'function' ? useMenuOpenState()[1] : () => {}
      return h(
        MenuItemButton,
        {
          danger: true,
          separatorBefore: true,
          icon: h(TrashIcon, { size: 14 }),
          onSelect: () => {
            closeMenu(false)
            openSingleDelete(sessionId, displayTitle, archived)
          },
        },
        t(archived ? 'menu.deleteArchived' : 'menu.deleteSession'),
      )
    }

    /**
     * Settings → Conversation cleanup section: the archived-set count, the
     * pending-queue notice and the batch deletion entry. Single-conversation
     * deletion stays in the sidebar row menu.
     * @param {object} props - archive info hook, status hook, actions and locale seat.
     * @returns {object} the section.
     */
    function SessionCleanerSettingsSection(props) {
      const { useArchivedInfo, useCleanerStatus, openPurge, refreshStatus, t } = props
      const info =
        typeof useArchivedInfo === 'function' ? useArchivedInfo((value) => value) : { count: 0, rows: [] }
      const status =
        typeof useCleanerStatus === 'function'
          ? useCleanerStatus((value) => value)
          : { phase: 'idle', pending: 0, error: null }
      React.useEffect(() => {
        refreshStatus()
      }, [refreshStatus])
      const count = info && typeof info.count === 'number' ? info.count : 0
      const pending = status && typeof status.pending === 'number' ? status.pending : 0
      const busy = status && status.phase === 'loading'
      return h(
        'div',
        { className: 'dshSessionCleaner_settings' },
        h('h2', { className: 'dshSessionCleaner_settingsTitle' }, t('settings.title')),
        h('p', { className: 'dshSessionCleaner_settingsIntro' }, t('settings.intro')),
        h(
          'section',
          { className: 'dshSessionCleaner_card', 'aria-label': t('settings.archivedTitle') },
          h(
            'div',
            { className: 'dshSessionCleaner_cardRow' },
            h(
              'div',
              null,
              h('h3', { className: 'dshSessionCleaner_cardTitle' }, t('settings.archivedTitle')),
              h('p', { className: 'dshSessionCleaner_cardDesc' }, t('settings.archivedDesc', { count })),
              pending > 0
                ? h('p', { className: 'dshSessionCleaner_settingsNote' }, t('settings.pending', { count: pending }))
                : null,
            ),
            h('span', { className: 'dshSessionCleaner_count', 'aria-hidden': 'true' }, String(count)),
          ),
          h('p', { className: 'dshSessionCleaner_settingsNote' }, t('settings.liveNote')),
          h('p', { className: 'dshSessionCleaner_settingsNote' }, t('settings.hint')),
          status && status.phase === 'error'
            ? h(
                'p',
                { className: 'dshSessionCleaner_error' },
                t('settings.error', { message: status.error || '' }),
              )
            : null,
          h(
            'div',
            { className: 'dshSessionCleaner_cardActions' },
            h(
              'button',
              {
                type: 'button',
                className: 'dshSessionCleaner_btn dshSessionCleaner_btnGhost dshSessionCleaner_btnSmall',
                disabled: busy === true,
                onClick: () => refreshStatus(),
              },
              t(busy === true ? 'settings.loading' : 'settings.refresh'),
            ),
            count > 0
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'dshSessionCleaner_btn dshSessionCleaner_btnDanger dshSessionCleaner_btnSmall',
                    onClick: () => openPurge(info),
                  },
                  t('settings.purgeAction', { count }),
                )
              : null,
          ),
        ),
        count === 0 ? h('p', { className: 'dshSessionCleaner_settingsNote' }, t('settings.empty')) : null,
      )
    }

    /**
     * Session-row hover action: open the delete confirmation for this row.
     * @param {object} props - row identity, callbacks and locale seat.
     * @returns {object} the icon button, wrapped in a tooltip.
     */
    function DeleteSessionRowButton(props) {
      const { sessionId, displayTitle, openSingleDelete, t } = props
      const button = h(
        'button',
        {
          type: 'button',
          className: 'dshSessionCleaner_rowAction',
          'aria-label': t('actions.delete'),
          title: t('actions.delete'),
          onClick: (event) => {
            event.stopPropagation()
            openSingleDelete(sessionId, displayTitle, false)
          },
        },
        h(TrashIcon, { size: 14 }),
      )
      return h(
        Tooltip,
        { label: t('actions.delete'), side: 'bottom', align: 'end', delayMs: 500, portal: true },
        button,
      )
    }

    /** One readonly bullet line. */
    function Bullet({ children }) {
      return h('li', null, children)
    }

    /**
     * The destructive confirmation dialog for one deletion or a batch.
     */
    function DeleteDialog({ request, t, onConfirm, onClose }) {
      const busy = request.busy === true
      const isBatch = request.kind === 'all'
      const title = isBatch ? t('dialog.purgeTitle') : t('dialog.deleteTitle')
      const description = isBatch
        ? t('dialog.purgeDesc', { count: request.count })
        : t('dialog.deleteDesc', { title: request.title || t('dialog.untitled') })

      let body = null
      if (isBatch) {
        const titles = Array.isArray(request.titles) ? request.titles.slice(0, 8) : []
        body = h(
          'div',
          { className: 'dshSessionCleaner_body' },
          h('p', { className: 'dshSessionCleaner_text' }, t('dialog.purgeBody')),
          titles.length > 0
            ? h(
                'ul',
                { className: 'dshSessionCleaner_list' },
                titles.map((row) => h(Bullet, { key: row.id }, row.title || t('dialog.untitled'))),
              )
            : null,
          request.count > titles.length
            ? h('p', { className: 'dshSessionCleaner_note' }, t('dialog.purgeMore', { count: request.count - titles.length }))
            : null,
          h('p', { className: 'dshSessionCleaner_note' }, t('dialog.purgeLive')),
          h('p', { className: 'dshSessionCleaner_note' }, t('dialog.deleteWarn')),
        )
      } else {
        body = h(
          'div',
          { className: 'dshSessionCleaner_body' },
          h('p', { className: 'dshSessionCleaner_text' }, t('dialog.deleteBody')),
          request.isCurrent === true ? h('p', { className: 'dshSessionCleaner_note' }, t('dialog.deleteCurrent')) : null,
          h('p', { className: 'dshSessionCleaner_note' }, t('dialog.deleteWarn')),
          request.archived === true ? h('p', { className: 'dshSessionCleaner_note' }, t('menu.deleteArchived')) : null,
        )
      }

      const footer = h(
        'div',
        { className: 'dshSessionCleaner_buttons' },
        h(
          'button',
          {
            type: 'button',
            className: 'dshSessionCleaner_btn',
            disabled: busy,
            onClick: onClose,
          },
          t('dialog.cancel'),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'dshSessionCleaner_btn dshSessionCleaner_btnDanger',
            disabled: busy,
            onClick: onConfirm,
          },
          busy ? t('dialog.busy') : t(isBatch ? 'dialog.confirmPurge' : 'dialog.confirmDelete'),
        ),
      )

      return h(
        Modal,
        {
          open: true,
          title,
          closeLabel: t('dialog.cancel'),
          description,
          onClose: busy ? () => {} : onClose,
          footer,
        },
        body,
        request.errorCode
          ? h(
              'p',
              { className: 'dshSessionCleaner_error' },
              request.errorCode === 'host'
                ? t('error.host')
                : t('error.request', { message: request.errorDetail || '' }),
            )
          : null,
      )
    }

    /** The floating result toast; the store drives its lifetime. */
    function ToastView({ toast, t, clearToast }) {
      React.useEffect(() => {
        if (!toast || !Array.isArray(toast.parts) || toast.parts.length === 0) return undefined
        const timer = setTimeout(clearToast, TOAST_MS)
        return () => clearTimeout(timer)
      }, [toast, clearToast])
      if (!toast || !Array.isArray(toast.parts) || toast.parts.length === 0) return null
      const text = toast.parts
        .map((part) => t(part.key, part.params === undefined ? undefined : part.params))
        .join('；')
      const toneClass =
        toast.tone === 'error'
          ? ' dshSessionCleaner_toastError'
          : toast.tone === 'warn'
            ? ' dshSessionCleaner_toastWarn'
            : ''
      return h('div', { className: 'dshSessionCleaner_toast' + toneClass, role: 'status' }, text)
    }

    /** The single `shell.overlay` entry: confirmation dialog and result toast. */
    function SessionCleanerOverlay(props) {
      const { useCleanerRequest, useCleanerToast, confirmDelete, closeDialog, clearToast, t } = props
      const request = typeof useCleanerRequest === 'function' ? useCleanerRequest((value) => value) : null
      const toast = typeof useCleanerToast === 'function' ? useCleanerToast((value) => value) : null
      return h(
        React.Fragment,
        null,
        request !== null && request !== undefined
          ? h(DeleteDialog, {
              request,
              t,
              onConfirm: () => confirmDelete(request),
              onClose: closeDialog,
            })
          : null,
        h(ToastView, { toast, t, clearToast }),
      )
    }

    /* ------------------------------------------------------------------ */
    /* Plugin                                                             */
    /* ------------------------------------------------------------------ */

    /**
     * Mount the browser half.
     * @param {object} ctx - Cordis Client root context.
     */
    function apply(ctx) {
      // ---- styles + dictionaries -------------------------------------
      ctx.effect(() => {
        const tag = document.createElement('style')
        tag.textContent = CSS
        tag.dataset.dshSessionCleaner = ''
        document.head.appendChild(tag)
        return () => {
          tag.remove()
        }
      }, 'session-cleaner: styles')
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'session-cleaner: dictionaries')
      const t = ctx.locale.bind(NS)

      // ---- stores -----------------------------------------------------
      const workspaces = ctx.uiWorkspace.workspaces.list
      const sessionsList = ctx.uiWorkspace.sessions.list
      const archivedSet = derive([workspaces], () => new Set(workspaces.getSnapshot().archivedSessionIds || []))
      const archivedInfo = derive([workspaces, sessionsList], () => {
        const workspaceState = workspaces.getSnapshot()
        const sessionState = sessionsList.getSnapshot()
        const ids = Array.isArray(workspaceState.archivedSessionIds)
          ? workspaceState.archivedSessionIds.slice()
          : []
        const byId = sessionState && sessionState.byId ? sessionState.byId : {}
        const rows = ids.map((id) => ({
          id,
          title: byId[id] && (byId[id].displayTitle || byId[id].title) ? byId[id].displayTitle || byId[id].title : '',
        }))
        return { count: ids.length, ids, rows }
      })
      const requestStore = createStore(null)
      const toastStore = createStore(null)
      const statusStore = createStore({ phase: 'idle', pending: 0, error: null })
      let statusSequence = 0

      /**
       * Read the Host's authoritative cleanup status for the settings section.
       * A superseded reply never overwrites a newer one.
       */
      const refreshStatus = async () => {
        const sequence = ++statusSequence
        statusStore.set({ ...statusStore.getSnapshot(), phase: 'loading' })
        try {
          const value = await callApi('status', {})
          if (sequence !== statusSequence) return
          statusStore.set({
            phase: 'ready',
            pending: Array.isArray(value.pending) ? value.pending.length : 0,
            error: null,
          })
        } catch (error) {
          if (sequence !== statusSequence) return
          statusStore.set({ phase: 'error', pending: 0, error: messageOf(error) })
        }
      }

      // ---- actions ----------------------------------------------------
      const refreshSessionList = async () => {
        try {
          if (typeof ctx.sessions.refresh === 'function') await ctx.sessions.refresh()
        } catch (error) {
          console.warn('session-cleaner: session list refresh failed:', error)
        }
      }

      /** Navigate away from the current conversation so the Host may release it. */
      const navigateAway = () => {
        try {
          ctx.uiWorkspace.startSession()
        } catch (error) {
          console.warn('session-cleaner: could not open a new conversation:', error)
        }
      }

      /** Turn a Host response into toast parts. */
      const resultParts = (value) => {
        const parts = []
        if (Array.isArray(value.deleted) && value.deleted.length > 0) {
          parts.push({ key: 'toast.deleted', params: { count: value.deleted.length } })
        }
        if (Array.isArray(value.deferred) && value.deferred.length > 0) {
          parts.push({ key: 'toast.deferred', params: { count: value.deferred.length } })
        }
        if (Array.isArray(value.active) && value.active.length > 0) {
          parts.push({ key: 'toast.active', params: { count: value.active.length } })
        }
        if (Array.isArray(value.live) && value.live.length > 0) {
          parts.push({ key: 'toast.live', params: { count: value.live.length } })
        }
        if (Array.isArray(value.missing) && value.missing.length > 0) {
          parts.push({ key: 'toast.missing', params: { count: value.missing.length } })
        }
        if (Array.isArray(value.failed) && value.failed.length > 0) {
          parts.push({ key: 'toast.failed', params: { count: value.failed.length } })
        }
        if (parts.length === 0) parts.push({ key: 'toast.none' })
        return parts
      }

      /** Execute the pending confirmation. */
      const confirmDelete = async (request) => {
        if (!request || request.busy === true) return
        requestStore.set({ ...request, busy: true, errorCode: null, errorDetail: null })
        try {
          let value
          if (request.kind === 'all') {
            value = await callApi('delete', { scope: 'archived', deferLive: false })
          } else {
            const isCurrent = currentSessionId(ctx) === request.sessionId
            if (isCurrent) {
              navigateAway()
              await delay(NAVIGATION_SETTLE_MS)
            }
            value = await callApi('delete', { ids: [request.sessionId], deferLive: false })
          }
          await refreshSessionList()
          await refreshStatus()
          requestStore.set(null)
          const failed = Array.isArray(value.failed) && value.failed.length > 0
          const deferred = Array.isArray(value.deferred) && value.deferred.length > 0
          const liveHeld = Array.isArray(value.live) && value.live.length > 0
          toastStore.set({
            parts: resultParts(value),
            tone: failed ? 'error' : deferred || liveHeld ? 'warn' : 'success',
          })
        } catch (error) {
          const message = messageOf(error)
          requestStore.set({
            ...request,
            busy: false,
            errorCode: message === 'host' ? 'host' : 'request',
            errorDetail: message,
          })
        }
      }

      const closeDialog = () => {
        const request = requestStore.getSnapshot()
        if (request && request.busy === true) return
        requestStore.set(null)
      }

      const openSingleDelete = (sessionId, displayTitle, archived) => {
        requestStore.set({
          kind: 'one',
          sessionId,
          title: displayTitle || '',
          archived: archived === true,
          isCurrent: currentSessionId(ctx) === sessionId,
          busy: false,
          errorCode: null,
          errorDetail: null,
        })
      }

      const openPurge = (info) => {
        const current = info && typeof info.count === 'number' ? info : archivedInfo.getSnapshot()
        requestStore.set({
          kind: 'all',
          count: current.count,
          titles: Array.isArray(current.rows) ? current.rows.slice(0, 8) : [],
          busy: false,
          errorCode: null,
          errorDetail: null,
        })
      }

      // ---- slot registrations ----------------------------------------
      ctx.slots.inject('sidebar.workspaces.session.menu.item', () =>
        ctx.slots.register(
          {
            name: 'sidebar.workspaces.session.menu.item',
            id: 'session-cleaner.delete-session',
            order: 500,
            locale: NS,
            inject: () => ({
              hooks: { archived: archivedSet },
              openSingleDelete,
            }),
          },
          DeleteSessionMenuItem,
        ),
      )

      ctx.slots.inject('sidebar.workspaces.session.row.action', function* registerSessionRowEntry() {
        yield ctx.slots.register(
          {
            name: 'sidebar.workspaces.session.row.action',
            id: 'session-cleaner.delete-session',
            order: 300,
            locale: NS,
            inject: () => ({
              openSingleDelete,
            }),
          },
          DeleteSessionRowButton,
        )
      })

      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'archived-sessions',
            order: 40,
            label: () => t('settings.nav'),
            locale: NS,
            inject: () => ({
              hooks: { archivedInfo, cleanerStatus: statusStore },
              openPurge,
              refreshStatus,
            }),
          },
          SessionCleanerSettingsSection,
        ),
      )

      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register(
          {
            name: 'shell.overlay',
            id: 'session-cleaner.overlay',
            order: 300,
            locale: NS,
            inject: () => ({
              hooks: { cleanerRequest: requestStore, cleanerToast: toastStore },
              confirmDelete,
              closeDialog,
              clearToast: () => toastStore.set(null),
            }),
          },
          SessionCleanerOverlay,
        ),
      )
    }

    return { NS, inject, apply }
  },
})
