// A file tab's state in the page, with no DOM and no CodeMirror (file.js draws it; node:test drives
// it with fakes). design-editor.md §2: the PAGE keeps its own base (the text and hash it last loaded
// or saved) and saves by compare-and-swap; the host keeps no merge state. So everything that must
// survive a new line to the host (a host restart, a browser view's reconnect, a relay resync) lives
// here, and `connect()` re-sends what the page holds: it opens the file again (the host forgot the
// watch), compares what is on disk with its base, and saves again when a save was in flight.
//
// The host's protocol (dist/lib/files.js serveFileTab, plus host.js for micro, settings and goto):
//   page -> host  { t: 'open', req, first? }       the tab's file (`first`: the page's first load, so the
//                                                  host moves it to the tab's line); watches it
//                 { t: 'read', req, path }         read again (a disk event, a re-check on focus)
//                 { t: 'save', req, path, baseHash, eol, bom, part, parts, text }
//                                                  in parts under the message cap; baseHash null
//                                                  creates a file that is not there
//                 { t: 'micro' }                   "Open in micro" (the host opens it on the tab's file)
//                 { t: 'conflict', on }            the page holds a conflict (a merge to resolve, a file
//                                                  deleted or no longer savable): the host marks the tab
//                 { t: 'close' }                   the deleted bar's Close: the host closes the tab the
//                                                  person's way (core's ask for unsaved text)
//   host -> page  { t: 'file', req, path, exists, hash, readOnly, why?, eol, bom, size, part, parts, text? }
//                 { t: 'saved', req, path, hash }
//                 { t: 'changed', req, path, hash, deleted?, written?, theirsHash?, part, parts, text? }
//                 { t: 'disk', path, change: 'changed' | 'deleted', hash }
//                 { t: 'error', req?, path?, message }
//                 { t: 'settings', idleSeconds, onBlur }   autosave (the plugin's settings)
//                 { t: 'goto', line, col?, focus? } move the cursor (a file opened again at a line);
//                                                  `focus: false` (ccc edit) leaves the keyboard where it is
//
// A change on disk reaches a clean buffer as a reload (file.js applies it as line edits, so the
// cursor, selections and scroll map through it, and flashes the lines). A change that meets a dirty
// buffer (a disk event while dirty, or a save answered `changed`) is MERGED three ways (merge.mjs):
// the page's base, its buffer and theirs. A clean merge is applied and saved with a notice; one with
// conflicts shows them inline (my version in the text, theirs beside it, Keep mine / Take Claude's /
// Keep both) and nothing is saved until every one is resolved. While they are open the page does not
// merge again: the save after the last one is a compare-and-swap against the base the merge took, so
// a newer change on disk comes back as `changed` and is merged then, onto the resolved text.
// Only a file that can no longer be saved here (it became read-only, binary or too large) is a
// plain conflict, with Reload alone.
// A file that turns read-only with its bytes unchanged (chmod, a second hard link) is no conflict:
// the buffer keeps its text and, holding unsaved edits, STAYS dirty (core asks before a close or an
// unmount drops them), and the bar says they cannot be saved there (view `stranded`), with Reload
// to drop them. Writable again, autosave picks them up.

import { merge3, mergedText, conflictLayout } from './merge.mjs'
import { chunkText, partsCollector } from './parts.mjs'

export { chunkText, CHUNK_CHARS } from './parts.mjs'

/** A dirty check after typing waits this long (a full compare of a big buffer on every key would lag). */
export const DIRTY_CHECK_MS = 120
/** The autosave default until the host's settings come (the manifest's). */
export const DEFAULT_IDLE_SECONDS = 3
/** How long the "merged" notice stays in the bar. */
export const NOTICE_MS = 6000
/** The notice of a clean merge (design-editor.md §2). */
export const MERGED_NOTICE = "Merged Claude's changes."
/** A tab path outside the project: absolute (the host names project files relative). */
export const isOutsidePath = (p) => typeof p === 'string' && (p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p))
/** A write lost from disk during our save that was not text: nothing to merge, only said. */
export const LOST_NOT_TEXT = 'Another write to this file landed during the save and was replaced; it was not text, so it could not be merged.'

/**
 * The session of one file tab. `ui`:
 *   post(message)            to the host (ccPanel.post)
 *   load(text, info)         show the file for the first time (a fresh editor state)
 *   replace(text, info)      show `text` instead of the buffer (a reload, a clean merge: applied as
 *                            line edits, the cursor mapped, the changed lines flashed)
 *   merge(layout)            show a merge with conflicts: merge.mjs conflictLayout's { text, conflicts };
 *                            the page tells how many are left with conflictsLeft(n)
 *   getText()                the buffer now
 *   goto(line, col, focus)   move the cursor; `focus` false keeps the keyboard where it is
 *   setDirty(dirty)          ccPanel.tab.setDirty
 *   render(view)             draw the header and the bar from view() (called on every change)
 * `timers` { set(fn, ms) -> handle, clear(handle) } (tests pass fakes).
 */
export function createSession(ui, timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h) }) {
  const s = {
    connected: false,
    loaded: false,
    path: null,
    exists: false,
    readOnly: false,
    why: undefined,
    noText: false,
    eol: '\n',
    bom: false,
    base: { text: '', hash: null },
    dirty: false,
    saving: null, // { req, text }
    saveAgain: false,
    // The text of a save the old line lost (connect()): the reconnect answer may find it on disk.
    lost: null,
    // { kind: 'merge', count }: conflicts of a merge shown inline, `count` still open.
    // { kind: 'changed', head, text, final: true }: theirs can no longer be saved over (read-only,
    //   binary, too large), so only Reload is offered; `head` and `text` are the host's answer.
    // { kind: 'deleted' }: gone from disk; Save recreates it, Close closes the tab.
    conflict: null,
    error: null,
    // A passing line in the bar ("Merged Claude's changes."), gone after NOTICE_MS.
    notice: null,
    settings: { idleSeconds: DEFAULT_IDLE_SECONDS, onBlur: true },
  }
  let nextReq = 0
  /** req -> { kind: 'open' | 'reconnect' | 'reconnect-text' | 'check' | 'reload', parts } */
  const reads = new Map()
  /** The `changed` answer being assembled: { req, parts }. */
  let changed = null
  let idleTimer = null
  let dirtyTimer = null
  let lastStatus = null
  /** A `goto` that came before the text: { line, col, focus }. */
  let pendingGoto = null
  let noticeTimer = null
  /** The conflict marker last told to the host (`conflict` message), null before the first. */
  let toldMarked = null

  function statusNow() {
    if (!s.loaded) return 'loading'
    if (s.saving) return 'saving'
    return s.dirty ? 'unsaved' : 'saved'
  }

  const view = () => ({
    loaded: s.loaded,
    path: s.path,
    exists: s.exists,
    readOnly: s.readOnly,
    why: s.why,
    noText: s.noText,
    dirty: s.dirty,
    status: statusNow(),
    conflict: s.conflict
      ? { kind: s.conflict.kind, final: s.conflict.final === true, ...(s.conflict.kind === 'merge' ? { count: s.conflict.count } : {}) }
      : null,
    error: s.error,
    notice: s.notice,
    // Unsaved edits in a buffer the file no longer lets us save (roChanged).
    stranded: s.readOnly && s.dirty && !s.conflict,
    // A read-only tab whose file is not there (an outside one restored after it was removed): shown
    // as missing, never as a new file to create.
    missing: s.loaded && !s.exists && s.readOnly && !s.conflict,
  })

  /** The tab's conflict marker follows s.conflict: told to the host on a change (and on every connect). */
  function tellMarker(force) {
    const marked = s.conflict !== null
    if (!force && marked === toldMarked) return
    toldMarked = marked
    ui.post({ t: 'conflict', on: marked })
  }

  function update() {
    lastStatus = statusNow()
    if (s.connected) tellMarker(false)
    ui.render(view())
  }

  function showNotice(text) {
    s.notice = text
    if (noticeTimer !== null) timers.clear(noticeTimer)
    noticeTimer = timers.set(() => {
      noticeTimer = null
      s.notice = null
      update()
    }, NOTICE_MS)
  }

  const merging = () => s.conflict !== null && s.conflict.kind === 'merge'

  function setDirty(dirty) {
    if (dirty === s.dirty) return
    s.dirty = dirty
    ui.setDirty(dirty)
  }

  /**
   * Compare the buffer with the base now. A file not on disk is dirty while it holds any text. A
   * read-only one is compared too: it cannot be typed in, but edits made before it turned read-only
   * are still unsaved, and clearing the flag would let a close or the LRU drop them without an ask.
   */
  function checkDirty() {
    if (dirtyTimer !== null) timers.clear(dirtyTimer)
    dirtyTimer = null
    if (!s.loaded || s.noText) return setDirty(false)
    const text = ui.getText()
    setDirty(s.exists ? text !== s.base.text : text !== '')
  }

  function clearIdle() {
    if (idleTimer !== null) timers.clear(idleTimer)
    idleTimer = null
  }

  function armIdle() {
    clearIdle()
    const secs = s.settings.idleSeconds
    if (!(secs > 0) || s.conflict) return
    idleTimer = timers.set(() => {
      idleTimer = null
      save()
    }, secs * 1000)
  }

  function request(kind, message) {
    const req = ++nextReq
    reads.set(req, { kind, parts: partsCollector() })
    ui.post({ ...message, req })
  }

  /**
   * Save the buffer when it differs from the base. Not while loading, read-only, in a conflict or
   * with no line to the host; a save asked while one is in flight runs after it.
   */
  function save() {
    clearIdle()
    if (!s.loaded || s.readOnly || s.noText || s.conflict || !s.connected) return false
    if (s.saving) {
      s.saveAgain = true
      return false
    }
    const text = ui.getText()
    if (s.exists && text === s.base.text) {
      checkDirty()
      update()
      return false
    }
    // A file that is not there (never created, or deleted and the person chose Save) is created only
    // while it is still absent: baseHash null.
    const baseHash = s.exists ? s.base.hash : null
    const req = ++nextReq
    s.saving = { req, text }
    s.saveAgain = false
    s.error = null
    const parts = chunkText(text)
    parts.forEach((part, i) => {
      ui.post({ t: 'save', req, path: s.path, baseHash, eol: s.eol, bom: s.bom, part: i, parts: parts.length, text: part })
    })
    update()
    return true
  }

  /** The file's head and text, as a load or a clean reload takes them. */
  function adopt(head, text) {
    s.path = head.path
    s.exists = head.exists === true
    // A tab outside the project (a definition in node_modules) is read-only whether or not its file
    // is there: the host never saves an absolute path, so a restored one whose file is gone must not
    // turn into an editable "New file" whose every save is refused.
    const outside = isOutsidePath(head.path)
    // The host's word counts for a missing file too: a read-only guest's view of a file that is not there yet
    // (lib/guests.js) is not a new file to create. The host's own answer for a missing file carries no flag.
    s.readOnly = head.readOnly === true || outside
    s.why = s.readOnly ? head.why || (outside ? 'outside' : undefined) : undefined
    s.noText = s.exists && typeof text !== 'string'
    if (s.exists) {
      s.eol = head.eol === '\r\n' ? '\r\n' : '\n'
      s.bom = head.bom === true
    }
    s.base = { text: typeof text === 'string' ? text : '', hash: s.exists ? head.hash : null }
  }

  /** Theirs is there but cannot be saved over here (read-only, binary, too large): Reload alone. */
  function finalConflict(head, text) {
    s.exists = true
    s.conflict = { kind: 'changed', head, text, final: true }
    s.notice = null
    clearIdle()
    checkDirty()
    update()
  }

  /** Whether theirs can be merged: text the host lets us save over. */
  const mergeable = (head, text) => typeof text === 'string' && head.readOnly !== true

  /** The line ending and BOM a file head carries (a `file` answer; a `changed` one has none). */
  function takeFormat(head) {
    if (head.eol === '\r\n' || head.eol === '\n') s.eol = head.eol
    if (typeof head.bom === 'boolean') s.bom = head.bom
  }

  /**
   * Theirs met a buffer with edits the disk does not have: merge (baseText, the buffer, theirs) and
   * take `next` ({ text, hash }: what is on disk now) as the base. Clean: the buffer becomes the
   * merge, saved at once, with a notice. Conflicts: shown inline, no save until all are resolved.
   */
  function mergeIn(baseText, theirs, next) {
    const mine = ui.getText()
    const r = merge3(baseText, mine, theirs)
    const text = r.conflicts === 0 ? mergedText(r.chunks) : null
    // The page shows the merge FIRST: should drawing it fail, the base must not have moved, or the
    // next save would be a compare-and-swap on theirs with my unmerged text and drop their change.
    // A stranded buffer (read-only with unsaved edits, roChanged) whose file is writable again: the
    // editor must take input again even when the merge leaves the text as it is.
    if (text === null) ui.merge(conflictLayout(r.chunks))
    else if (text !== mine || s.readOnly) ui.replace(text, { readOnly: false, noText: false })
    // A save in flight was made against the base this merge replaces: its answer must not move it.
    if (s.saving) s.saving.superseded = true
    s.base = next
    s.exists = true
    s.readOnly = false
    s.why = undefined
    s.noText = false
    s.error = null
    if (text !== null) {
      s.conflict = null
      showNotice(MERGED_NOTICE)
      checkDirty()
      update()
      if (s.dirty) save()
      return
    }
    s.conflict = { kind: 'merge', count: r.conflicts }
    s.notice = null
    clearIdle()
    checkDirty()
    update()
  }

  /** The disk's file is gone: the tab keeps its text, clean or not; the file comes back only on Save. */
  function deletedConflict() {
    s.exists = false
    // Conflicts still open stay: the deleted bar comes once they are resolved (conflictsLeft).
    if (!merging()) s.conflict = { kind: 'deleted' }
    s.notice = null
    clearIdle()
    checkDirty()
    update()
  }

  /** A second look found disk different from the base: take it when clean, else merge. */
  function diskDiffers(head, text) {
    // Gone: the same answer as a `deleted` event (a clean tab too: a read that lost a race with a
    // deletion must not wipe the buffer and hide the loss).
    if (!head.exists) return deletedConflict()
    // Disk holds what the buffer holds (a save whose answer the old line lost, the same edit made
    // twice): only the hash moves.
    if (typeof text === 'string' && !s.noText && text === ui.getText()) {
      s.base = { text, hash: head.hash }
      s.exists = true
      s.conflict = null
      // Its flags move with it (a stranded buffer whose file is writable again, or the reverse).
      const ro = head.readOnly === true
      if (ro !== s.readOnly) {
        s.readOnly = ro
        s.why = ro ? head.why : undefined
        ui.replace(text, { readOnly: ro, noText: false })
      }
      checkDirty()
      return update()
    }
    if (!s.dirty && !s.saving) {
      adopt(head, text)
      s.conflict = null
      ui.replace(s.base.text, { readOnly: s.readOnly, noText: s.noText })
      checkDirty()
      return update()
    }
    if (!mergeable(head, text)) return finalConflict(head, text)
    takeFormat(head)
    mergeIn(s.base.text, text, { text, hash: head.hash })
  }

  /**
   * The hash is the base's but the host now calls the file read-only (or writable again): the flags
   * move, the buffer stays, and so does its dirty flag (view `stranded` while it cannot be saved).
   * Writable again with edits still unsaved: autosave picks them up.
   */
  function roChanged(head) {
    s.readOnly = head.readOnly === true
    s.why = s.readOnly ? head.why : undefined
    ui.replace(ui.getText(), { readOnly: s.readOnly, noText: s.noText })
    clearIdle()
    checkDirty()
    update()
    if (s.dirty && !s.readOnly) armIdle()
  }

  function onFile(m) {
    const r = reads.get(m.req)
    if (!r) return
    const done = r.parts.add(m)
    if (!done) return
    reads.delete(m.req)
    const { head, text } = done
    if (!s.loaded) {
      adopt(head, text)
      s.loaded = true
      ui.load(s.base.text, { path: s.path, readOnly: s.readOnly, noText: s.noText })
      if (pendingGoto && !s.noText) ui.goto(pendingGoto.line, pendingGoto.col, pendingGoto.focus)
      pendingGoto = null
      checkDirty()
      return update()
    }
    // A second look: the open after a reconnect, a re-check on focus, a read after a disk event.
    // `reconnect-text`: the text a reconnect's head-only answer asked for (below), the same reconnect.
    const reconnect = r.kind === 'reconnect' || r.kind === 'reconnect-text'
    if (merging()) {
      // Conflicts open: no second merge on top of them, only whether the file is there moves. The
      // save after the last conflict is a compare-and-swap on the merge's base, so a change made
      // since comes back as `changed` then and is merged onto the resolved text.
      if (reconnect) s.lost = null
      if (!head.exists) return deletedConflict()
      s.exists = true
      return update()
    }
    const nowHash = head.exists ? head.hash : null
    // A reconnect's head-only answer for a file whose hash moved: the text is needed (a merge, a
    // reload, the lost save's check), asked for as the same reconnect (the new line watches already).
    if (r.kind === 'reconnect' && head.exists && typeof text !== 'string' && !s.noText && nowHash !== (s.exists ? s.base.hash : null)) {
      request('reconnect-text', { t: 'read', path: s.path })
      return
    }
    const lost = s.lost
    if (reconnect) s.lost = null
    // A save lost with the old line that DID land, with more typed after it: disk holds that save's
    // text, not the buffer. It is our own write, so it becomes the base and the buffer stays dirty
    // (not a conflict that would offer to drop the newer typing).
    if (reconnect && head.exists && lost !== null && typeof text === 'string' && text === lost && nowHash !== (s.exists ? s.base.hash : null)) {
      s.base = { text, hash: head.hash }
      s.exists = true
      s.conflict = null
      checkDirty()
      update()
      if (s.dirty) save()
      return
    }
    const sameHash = nowHash === (s.exists ? s.base.hash : null)
    if (sameHash && (!head.exists || (head.readOnly === true) === s.readOnly)) {
      // Disk is still our base. A save that was in flight when the line went never answered: send
      // it again (one that did land answers `changed` with our own text, which diskDiffers settles).
      // Only that one: a buffer nobody asked to save (autosave off, the idle timer still waiting)
      // stays unsaved; a reconnect is not the person's Ctrl+S (found by the browser-view e2e).
      if (reconnect && lost !== null && s.dirty && !s.conflict) save()
      return update()
    }
    if (sameHash) return roChanged(head)
    // A head-only re-check (focus) carries no text: ask for the file once it really differs.
    if (r.kind === 'check' && head.exists && typeof text !== 'string') {
      request('reload', { t: 'read', path: s.path })
      return
    }
    diskDiffers(head, text)
  }

  function onSaved(m) {
    if (!s.saving || m.req !== s.saving.req) return
    if (merging()) {
      // A save sent before a merge raised conflicts: the merge's base stays the base (the save
      // after the last conflict compares against it, and merges whatever differs then).
      s.saving = null
      s.saveAgain = false
      return update()
    }
    if (!s.saving.superseded) s.base = { text: s.saving.text, hash: m.hash }
    s.exists = true
    s.saving = null
    const again = s.saveAgain
    s.saveAgain = false
    checkDirty()
    update()
    if (s.dirty) {
      if (again) save()
      else armIdle()
    }
  }

  function onChanged(m) {
    if (!s.saving || m.req !== s.saving.req) return
    if (!changed || changed.req !== m.req) changed = { req: m.req, parts: partsCollector() }
    const done = changed.parts.add(m)
    if (!done) return
    changed = null
    const { head, text } = done
    const mine = s.saving.text
    const baseText = s.base.text
    s.saving = null
    s.saveAgain = false
    if (head.deleted) return deletedConflict()
    // Conflicts open already (a disk change merged while this save was in flight): no merge on top.
    if (merging()) return update()
    if (head.written) {
      // Our text is on disk (head.hash, our new base), but a write into the old file landed in
      // between and is lost from disk: `text` is that write, made on the base we saved from, so it
      // is merged into the buffer and the next save puts it back.
      if (typeof text === 'string') return mergeIn(baseText, text, { text: mine, hash: head.hash })
      s.base = { text: mine, hash: head.hash }
      s.exists = true
      s.error = LOST_NOT_TEXT
    } else if (typeof text === 'string' && text === ui.getText()) {
      // Theirs is what we hold (our own earlier save that the old line never confirmed).
      s.base = { text, hash: head.hash }
      s.exists = true
    } else if (!mergeable(head, text)) {
      return finalConflict(head, text)
    } else {
      return mergeIn(baseText, text, { text, hash: head.hash })
    }
    clearIdle()
    checkDirty()
    update()
    if (s.dirty) armIdle()
  }

  function onDisk(m) {
    if (m.path !== s.path || !s.loaded) return
    if (m.change === 'deleted') {
      // The tab stays with its text; the file comes back only on the person's Save.
      if (s.exists) deletedConflict()
      return
    }
    if (s.exists && m.hash === s.base.hash) return // what we hold (our own write)
    request('reload', { t: 'read', path: s.path })
  }

  function onError(m) {
    if (s.saving && m.req === s.saving.req) {
      s.saving = null
      s.saveAgain = false
    }
    reads.delete(m.req)
    s.error = typeof m.message === 'string' ? m.message.slice(0, 500) : 'error'
    checkDirty()
    update()
  }

  return {
    view,
    /** A new line to the host (ccPanel.onConnect): the first, or after a restart or a reconnect. */
    connect() {
      s.connected = true
      // What was in flight on the old line is lost: its answers never come.
      reads.clear()
      changed = null
      if (s.saving) s.lost = s.saving.text
      s.saving = null
      s.saveAgain = false
      // A reconnect asks for the head only (hash and flags): the page holds its base, and the text
      // is asked for (`reconnect-text`) only when the disk differs. A relay that paused this line in
      // a whole file's burst would otherwise get the same burst again on every resync.
      if (!s.loaded) request('open', { t: 'open', first: true })
      else request('reconnect', { t: 'open', headOnly: true })
      // The new line's host may not know the tab's marker (a host restart): said on every line.
      tellMarker(true)
      update()
    },
    receive(m) {
      if (!m || typeof m !== 'object' || Array.isArray(m)) return
      switch (m.t) {
        case 'file':
          return onFile(m)
        case 'saved':
          return onSaved(m)
        case 'changed':
          return onChanged(m)
        case 'disk':
          return onDisk(m)
        case 'error':
          return onError(m)
        case 'settings': {
          const idle = Number.isInteger(m.idleSeconds) && m.idleSeconds >= 0 ? m.idleSeconds : DEFAULT_IDLE_SECONDS
          s.settings = { idleSeconds: idle, onBlur: m.onBlur !== false }
          if (s.dirty) armIdle()
          else clearIdle()
          return
        }
        case 'goto': {
          if (!Number.isInteger(m.line) || m.line < 1) return
          const col = Number.isInteger(m.col) && m.col >= 1 ? m.col : 1
          // `ccc edit` on a shown tab: the person may be typing elsewhere in the window (a terminal
          // overlay, a panel input), so the cursor moves without pulling the keyboard into the frame.
          const focus = m.focus !== false
          // Before the text is in (its parts still coming): moved once it is.
          if (!s.loaded) pendingGoto = { line: m.line, col, focus }
          else ui.goto(m.line, col, focus)
          return
        }
        default:
          return // a newer host's message
      }
    },
    /** The buffer changed (typing, a paste, undo). */
    edited() {
      if (!s.loaded || s.readOnly || s.noText) return
      // Dirty at once (the dot shows on the first key); the exact compare (undo back to the base) waits.
      setDirty(true)
      if (dirtyTimer !== null) timers.clear(dirtyTimer)
      dirtyTimer = timers.set(() => {
        dirtyTimer = null
        checkDirty()
        update()
      }, DIRTY_CHECK_MS)
      armIdle()
      if (statusNow() !== lastStatus) update()
    },
    /** Focus left the page (another tab, another window). */
    blur() {
      if (s.settings.onBlur && s.dirty) save()
    },
    /** The page got the focus back: look at the disk again (a watch can miss a change, e.g. on a network mount). */
    focus() {
      if (s.loaded && s.connected && !s.saving) request('check', { t: 'read', path: s.path, headOnly: true })
    },
    /** Ctrl+S, or Save in the deleted bar (which recreates the file). */
    saveNow() {
      const was = s.conflict
      if (was && was.kind === 'deleted') s.conflict = null
      if (save()) return true
      // Nothing was sent (not connected, a save in flight): the file is still gone, the bar stays.
      if (was && was.kind === 'deleted' && s.conflict === null) {
        s.conflict = was
        update()
      }
      return false
    },
    /** The stranded bar's Reload: a read-only file's unsaved edits are dropped, the buffer is the file again. */
    revert() {
      if (!s.readOnly || !s.dirty || s.conflict) return
      ui.replace(s.base.text, { readOnly: true, noText: s.noText })
      checkDirty()
      update()
    },
    /** The final conflict's Reload: the buffer, the base and the flags become theirs. */
    takeTheirs() {
      const c = s.conflict
      if (!c || c.kind !== 'changed') return
      s.conflict = null
      adopt({ ...c.head, exists: true, path: s.path }, c.text)
      ui.replace(s.base.text, { readOnly: s.readOnly, noText: s.noText })
      checkDirty()
      update()
    },
    /**
     * The page's inline conflicts went down to `n` (the person picked Keep mine, Take Claude's or
     * Keep both). At 0 the buffer is plain text again: autosave resumes, or the deleted bar comes
     * when the file went meanwhile.
     */
    conflictsLeft(n) {
      if (!merging() || !Number.isInteger(n) || n < 0) return
      if (n > 0) {
        s.conflict = { kind: 'merge', count: n }
        return update()
      }
      s.conflict = s.exists ? null : { kind: 'deleted' }
      checkDirty()
      update()
      if (s.dirty && !s.conflict) armIdle()
    },
    /** The deleted bar's Close: the host closes the tab the person's way (core asks for unsaved text). */
    closeTab() {
      ui.post({ t: 'close' })
    },
    /** Tests: the internal state. */
    _state: s,
  }
}
