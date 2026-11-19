'use strict'
// Guests on a file tab (design-guests §6, spec-review item 19, D-22, D-27, D-33). One tab instance is one
// view's page; main tags it with that view's access (`tab.access`: 'owner', 'read' or 'write'; an older
// app has none: the owner), never the page. guestTab wraps the instance before any of the tab's features
// (lib/files.js, search, git, LSP, Ask Claude, quick chat, notes, the host's own messages) sees it, so a
// refusal is in one place and a feature added later is covered by the allow-list, not by remembering to
// check:
//
// - a read-only guest reads the tab's own file and git's base for its gutter, nothing else (D-2: the
//   owner shared this file, not the project). Everything else is refused (an answer the page waits for
//   says why) or dropped: a read of any other path, quick open's file list and find in files (they list
//   and search the whole project: .env, .git/config), save, open another file, Open in micro, Close, the
//   Reviewer's diff, notes, quick chat, Ask Claude (no onDiscuss), and the language servers (the first
//   page to open a document is its owner and feeds the server its text, so a read-only page must never
//   hold one; it is answered like an app without servers);
// - a write guest works like the owner, except: a definition outside the project is not opened and not
//   even listed (its absolute path would reach the guest's page, D-33), the deleted bar's Close is refused
//   (host.js closes on the page's own conflict report, which a guest's page could fake to close a tab the
//   owner has unsaved text in without core's question, D-9: a guest closes from the tab bar, where main
//   asks), and quick chat's model pick is not remembered app-wide (that store is the owner's; host.js
//   passes a read-only one);
// - an instance of a tab on a file outside the project (`params.outside`) serves no guest at all.

/** A read-only guest's messages that reach the tab's features: reading the tab's own file only (`open` and `read` checked for the path too). */
const READ_OK = new Set(['open', 'read', 'unwatch', 'git-base'])

const READ_ONLY = 'You are a read-only guest: the host can give you write access.'

/**
 * The access main tagged the instance with. None at all (an older app, before guests) is the owner; any other
 * value this host does not know (a newer app's role, a malformed tag) is a read-only guest: never the owner.
 */
function accessOf(tab) {
  const a = tab && typeof tab === 'object' ? tab.access : undefined
  if (a === undefined || a === 'owner') return 'owner'
  return a === 'write' ? 'write' : 'read'
}

const WRITE_CLOSE = 'A guest closes a tab from the tab bar.'
const OUTSIDE = 'A file outside the project does not open for a guest.'

/**
 * The answer a refused message gets, in the shape the page waits for (a req, a chat id), or null to drop
 * it quietly (a report, a read of something a read-only guest has no use for).
 */
function refusal(m, message) {
  switch (m.t) {
    case 'save':
      return { t: 'error', ...(m.req !== undefined ? { req: m.req } : {}), ...(typeof m.path === 'string' ? { path: m.path } : {}), message }
    case 'openFile':
      return { t: 'search-error', kind: 'open', message }
    case 'files':
    case 'grep':
      return { t: 'search-error', kind: m.t, ...(m.req !== undefined ? { req: m.req } : {}), message }
    case 'open':
    case 'read':
      return { t: 'error', ...(m.req !== undefined ? { req: m.req } : {}), ...(typeof m.path === 'string' ? { path: m.path } : {}), message }
    case 'micro':
    case 'close':
    case 'git-review':
    case 'notes-add':
      return { t: 'error', message }
    case 'chat-start':
    case 'chat-say':
      return { t: 'chat-end', id: m.id, message, error: true }
    case 'lsp-open':
      return typeof m.path === 'string' ? { t: 'lsp-doc', path: m.path, language: null, why: 'a read-only guest has no language server' } : null
    case 'lsp-ask':
      return typeof m.req === 'string' || typeof m.req === 'number' ? { t: 'lsp-answer', req: m.req, result: null, unavailable: 'stopped' } : null
    default:
      return null
  }
}

/**
 * Whether `m` from a view with `access` may reach the tab's features; `path` is the tab's own file (main's
 * params). A read-only guest's `open` names no path (the tab's file) or that one, its `read` that one: the
 * page sends its own path (session.mjs), so any other is a page asking for more than was shared.
 */
function allowed(access, m, path) {
  if (access === 'owner') return true
  if (access === 'read') {
    if (!READ_OK.has(m.t)) return false
    if (m.t === 'open') return m.path === undefined || (typeof path === 'string' && m.path === path)
    if (m.t === 'read') return typeof path === 'string' && m.path === path
    return true
  }
  // A write guest: never a file outside the project, never the deleted bar's Close.
  return !(m.t === 'openFile' && m.outside !== undefined) && m.t !== 'close'
}

/** Shown by the page as "Read-only: <why>" (a why it has no label for is printed as is: no page build). */
const READ_GUEST_WHY = 'you are a read-only guest'

/**
 * A read-only guest's copy of a message about the file's bytes (`file`, a change): read-only, so the page
 * neither edits nor autosaves (the host refuses a save anyway; this spares the person the errors).
 */
function asReadOnly(m) {
  if (!m || typeof m !== 'object') return m
  // A missing file's answer has no flag: without one the page offers an editable "New file" (session.mjs adopt).
  const missing = m.t === 'file' && m.exists === false && m.readOnly === undefined
  if (m.readOnly !== false && !missing) return m
  return { ...m, readOnly: true, why: READ_GUEST_WHY }
}

/** A write guest's copy of an LSP answer without the locations outside the project (absolute paths). */
function withoutOutside(m) {
  if (!m || m.t !== 'lsp-answer' || !Array.isArray(m.result)) return m
  if (!m.result.some((r) => r && typeof r === 'object' && 'outside' in r)) return m
  return { ...m, result: m.result.filter((r) => !(r && typeof r === 'object' && 'outside' in r)) }
}

/**
 * The instance the tab's features get: the same members, its `onMessage` passing only what the viewer may
 * send, its `post` holding back owner-only data, no `onDiscuss` for a read-only guest. The refusals are
 * answered once, from one listener on the real instance.
 */
function guestTab(tab) {
  const access = accessOf(tab)
  if (access === 'owner') return { access, tab }
  const path = tab.params && typeof tab.params === 'object' ? tab.params.path : undefined
  tab.onMessage((m) => {
    if (!m || typeof m !== 'object' || allowed(access, m, path)) return
    const r = refusal(m, access === 'read' ? READ_ONLY : m.t === 'close' ? WRITE_CLOSE : OUTSIDE)
    if (r) tab.post(r)
  })
  const wrapped = {
    id: tab.id,
    type: tab.type,
    params: tab.params,
    view: tab.view,
    access,
    post: access === 'write' ? (m) => tab.post(withoutOutside(m)) : (m) => tab.post(asReadOnly(m)),
    onMessage: (fn) =>
      tab.onMessage((m) => {
        if (m && typeof m === 'object' && allowed(access, m, path)) fn(m)
      }),
    onClose: (fn) => tab.onClose(fn),
    setTitle: (...args) => tab.setTitle(...args),
  }
  if (access === 'write' && typeof tab.onDiscuss === 'function') wrapped.onDiscuss = (fn) => tab.onDiscuss(fn)
  return { access, tab: Object.freeze(wrapped) }
}

/** A store that reads the owner's remembered picks and keeps none (a guest's pick is not the owner's). */
function readOnlyStore(store) {
  if (!store || typeof store.get !== 'function') return undefined
  return Object.freeze({ get: (k) => store.get(k), set: async () => {} })
}

module.exports = { READ_OK, READ_GUEST_WHY, accessOf, allowed, asReadOnly, guestTab, readOnlyStore, refusal, withoutOutside }
