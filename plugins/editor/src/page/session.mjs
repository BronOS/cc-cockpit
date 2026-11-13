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
//   host -> page  { t: 'file', req, path, exists, hash, readOnly, why?, eol, bom, size, part, parts, text? }
//                 { t: 'saved', req, path, hash }
//                 { t: 'changed', req, path, hash, deleted?, written?, theirsHash?, part, parts, text? }
//                 { t: 'disk', path, change: 'changed' | 'deleted', hash }
//                 { t: 'error', req?, path?, message }
//                 { t: 'settings', idleSeconds, onBlur }   autosave (the plugin's settings)
//                 { t: 'goto', line, col? }        move the cursor (a file opened again at a line)
//
// A `changed` answer, or a change on disk while the buffer is dirty, is a CONFLICT: the page stops
// saving until the person picks (Reload, Keep mine). The three-way merge (plan Task 8) replaces
// that choice for most cases.

/** Text per save message, in UTF-16 units: the host's own chunk size (files.js CHUNK_CHARS), under the 1 MiB cap. */
export const CHUNK_CHARS = 128 * 1024
/** A dirty check after typing waits this long (a full compare of a big buffer on every key would lag). */
export const DIRTY_CHECK_MS = 120
/** The autosave default until the host's settings come (the manifest's). */
export const DEFAULT_IDLE_SECONDS = 3

/** `text` in parts of at most `size` units, never splitting a surrogate pair. At least one part. */
export function chunkText(text, size = CHUNK_CHARS) {
  const parts = []
  let i = 0
  while (i < text.length) {
    let end = Math.min(i + size, text.length)
    // A high surrogate at the cut would leave half a character in each part: harmless once the host
    // joins them, but no part should be broken UTF-16 on its own.
    if (end < text.length) {
      const c = text.charCodeAt(end - 1)
      if (c >= 0xd800 && c <= 0xdbff) end--
    }
    parts.push(text.slice(i, end))
    i = end
  }
  return parts.length ? parts : ['']
}

/**
 * Collects a message sent in parts ({ part, parts, text? }) under one req. `add` answers the head
 * (part 0's message) and the joined text (undefined when the parts carry none, a binary file) once
 * every part came, else null.
 */
function partsCollector() {
  let head = null
  const texts = []
  let got = 0
  return {
    add(m) {
      const i = Number.isInteger(m.part) && m.part >= 0 ? m.part : 0
      if (i === 0 || head === null) head = m
      if (!(i in texts)) got++
      texts[i] = typeof m.text === 'string' ? m.text : undefined
      const parts = Number.isInteger(m.parts) && m.parts >= 1 ? m.parts : 1
      if (got < parts) return null
      const all = texts.length === parts && texts.every((t) => typeof t === 'string')
      return { head, text: all ? texts.join('') : undefined }
    },
  }
}

/**
 * The session of one file tab. `ui`:
 *   post(message)            to the host (ccPanel.post)
 *   load(text, info)         show the file for the first time (a fresh editor state)
 *   replace(text)            show `text` instead of the buffer (a reload; keeps the cursor near)
 *   getText()                the buffer now
 *   goto(line, col)          move the cursor
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
    // { kind: 'changed', theirs, hash, written } | { kind: 'deleted' }
    conflict: null,
    error: null,
    settings: { idleSeconds: DEFAULT_IDLE_SECONDS, onBlur: true },
  }
  let nextReq = 0
  /** req -> { kind: 'open' | 'reconnect' | 'check' | 'reload', parts } */
  const reads = new Map()
  /** The `changed` answer being assembled: { req, parts }. */
  let changed = null
  let idleTimer = null
  let dirtyTimer = null
  let lastStatus = null
  /** A `goto` that came before the text: { line, col }. */
  let pendingGoto = null

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
    conflict: s.conflict ? { kind: s.conflict.kind } : null,
    error: s.error,
  })

  function update() {
    lastStatus = statusNow()
    ui.render(view())
  }

  function setDirty(dirty) {
    if (dirty === s.dirty) return
    s.dirty = dirty
    ui.setDirty(dirty)
  }

  /** Compare the buffer with the base now. A file not on disk is dirty while it holds any text. */
  function checkDirty() {
    if (dirtyTimer !== null) timers.clear(dirtyTimer)
    dirtyTimer = null
    if (!s.loaded || s.readOnly || s.noText) return setDirty(false)
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
    s.readOnly = s.exists && head.readOnly === true
    s.why = s.readOnly ? head.why : undefined
    s.noText = s.exists && typeof text !== 'string'
    if (s.exists) {
      s.eol = head.eol === '\r\n' ? '\r\n' : '\n'
      s.bom = head.bom === true
    }
    s.base = { text: typeof text === 'string' ? text : '', hash: s.exists ? head.hash : null }
  }

  /** A second look found disk different from the base: take it when clean, else a conflict. */
  function diskDiffers(head, text) {
    // Disk holds what the buffer holds (a save whose answer the old line lost, the same edit made
    // twice): only the hash moves.
    if (head.exists && typeof text === 'string' && !s.noText && text === ui.getText()) {
      s.base = { text, hash: head.hash }
      s.exists = true
      s.conflict = null
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
    if (head.exists) {
      s.conflict = { kind: 'changed', theirs: typeof text === 'string' ? text : '', hash: head.hash, written: false }
    } else {
      s.exists = false
      s.conflict = { kind: 'deleted' }
    }
    clearIdle()
    checkDirty()
    update()
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
      if (pendingGoto && !s.noText) ui.goto(pendingGoto.line, pendingGoto.col)
      pendingGoto = null
      checkDirty()
      return update()
    }
    // A second look: the open after a reconnect, a re-check on focus, a read after a disk event.
    const nowHash = head.exists ? head.hash : null
    const sameRo = !head.exists || (head.readOnly === true) === s.readOnly
    if (nowHash === (s.exists ? s.base.hash : null) && sameRo) {
      // Disk is still our base. A save that was in flight when the line went never answered: send
      // it again (one that did land answers `changed` with our own text, which diskDiffers settles).
      if (r.kind === 'reconnect' && s.dirty && !s.conflict) save()
      return update()
    }
    diskDiffers(head, text)
  }

  function onSaved(m) {
    if (!s.saving || m.req !== s.saving.req) return
    s.base = { text: s.saving.text, hash: m.hash }
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
    s.saving = null
    s.saveAgain = false
    if (head.deleted) {
      s.exists = false
      s.conflict = { kind: 'deleted' }
    } else if (head.written) {
      // Our text is on disk (head.hash, our new base), but a write into the old file landed in
      // between and is lost from disk: `text` is that write.
      s.base = { text: mine, hash: head.hash }
      s.exists = true
      s.conflict = { kind: 'changed', theirs: text ?? '', hash: head.hash, written: true }
    } else if (typeof text === 'string' && text === ui.getText()) {
      // Theirs is what we hold (our own earlier save that the old line never confirmed).
      s.base = { text, hash: head.hash }
      s.exists = true
    } else {
      s.exists = true
      s.conflict = { kind: 'changed', theirs: text ?? '', hash: head.hash, written: false }
    }
    clearIdle()
    checkDirty()
    update()
  }

  function onDisk(m) {
    if (m.path !== s.path || !s.loaded) return
    if (m.change === 'deleted') {
      if (!s.exists) return
      // The tab stays with its text; the file comes back only on the person's Save.
      s.exists = false
      s.conflict = { kind: 'deleted' }
      clearIdle()
      checkDirty()
      return update()
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
      s.saving = null
      s.saveAgain = false
      if (!s.loaded) request('open', { t: 'open', first: true })
      else request('reconnect', { t: 'open' })
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
          // Before the text is in (its parts still coming): moved once it is.
          if (!s.loaded) pendingGoto = { line: m.line, col }
          else ui.goto(m.line, col)
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
      if (s.loaded && s.connected && !s.saving) request('check', { t: 'read', path: s.path })
    },
    /** Ctrl+S, or Save in the deleted bar (which recreates the file). */
    saveNow() {
      if (s.conflict && s.conflict.kind === 'deleted') s.conflict = null
      return save()
    },
    /** The conflict bar's Reload: the buffer becomes theirs. */
    takeTheirs() {
      const c = s.conflict
      if (!c || c.kind !== 'changed') return
      s.conflict = null
      // Not written: theirs is on disk, so it is the base too. Written: our text is on disk, so the
      // buffer differs from it and the next save writes theirs back.
      if (!c.written) s.base = { text: c.theirs, hash: c.hash }
      ui.replace(c.theirs, { readOnly: s.readOnly, noText: s.noText })
      checkDirty()
      update()
      if (s.dirty) save()
    },
    /** The conflict bar's Keep mine: saved over theirs. */
    keepMine() {
      const c = s.conflict
      if (!c || c.kind !== 'changed') return
      s.conflict = null
      if (!c.written) s.base = { text: c.theirs, hash: c.hash }
      checkDirty()
      update()
      if (s.dirty) save()
    },
    /** Tests: the internal state. */
    _state: s,
  }
}
