'use strict'
// cc-cockpit overlay kit, host side (kit/README.md "Host"). One overlay's state for every view's copy of its page
// (manifest `overlays.perView`): each copy is greeted on its connect with its access and first side tab and gets
// the state as `project(state, from)` makes it for that copy, again on every set(). Posts always name one copy,
// never a broadcast. A state past the page message cap goes in chunks the kit's connect() joins.
//
// It acts on the kit's own messages by the access main filled in `from` (never anything the page says about
// itself): a link opens only when it is an http(s) URL of the document it holds, with that view's `from.view`;
// the last used tab is written for the owner only; Try again runs for the owner only. Plain CommonJS, no
// dependencies: copied into a plugin as it is (SHA256SUMS).
//
// Holder mode (an app before overlays.perView: the handle has no onConnect): one page, the overlay's holder, with
// one state. Its copy id is 'holder' and its access is `opts.holderAccess` (default 'read': such an app does not
// say who looks, so nothing is shown or allowed that a read guest could not have; a plugin that wants more says
// so), or the access main put in a message's `from` when an app fills it. The page is greeted when it says hello
// (connect() sends it on every load, so a reload is greeted again); posts go without a copy.

const ACCESS = ['owner', 'write', 'read']
const TAB_ID = /^[a-z][a-z0-9-]{0,39}$/
const TAB_KEY = 'cc-kit.tab'
/** The one copy of holder mode (no onConnect on the handle). */
const HOLDER = 'holder'
const GUEST_ERROR = 'This could not be loaded.'
/** A message's JSON past this (under the app's 1,040,384-char page message cap) goes in chunks. */
const MESSAGE_CHARS = 1000000
/**
 * The characters of state JSON per chunk: a chunk is a JSON string inside the message, and escaping can make a
 * character six (a control character as \u00XX), so 160,000 stay under MESSAGE_CHARS whatever they are.
 */
const CHUNK_CHARS = 160000
/** At most this many chunks (about 40 MB of JSON): a larger state fails that copy instead of flooding its port. */
const MAX_CHUNKS = 256
const MAX_URL = 2048

/** main's `from` of a copy, checked; null when it is not one. */
const viewerOf = (from) =>
  from && typeof from === 'object' && ACCESS.includes(from.access) && typeof from.copy === 'string' && from.copy !== '' && typeof from.view === 'string'
    ? from
    : null

/** An http(s) URL normalized as the page's renderer does (URL.href), or null. */
function httpUrl(raw) {
  if (typeof raw !== 'string') return null
  const v = raw.trim()
  if (!v || v.length > MAX_URL || /[\x00-\x1f\x7f]/.test(v)) return null
  try {
    const u = new URL(v)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null
  } catch {
    return null
  }
}

/**
 * The http(s) URLs in a text or HTML string, normalized: what a link click may open. An HTML attribute's `&amp;`
 * (and its numeric forms) is read as `&`; a URL's trailing punctuation is tried with and without.
 */
function urlsIn(document) {
  const out = new Set()
  if (typeof document !== 'string') return out
  const text = document.replace(/&amp;|&#0*38;|&#x0*26;/gi, '&')
  const found = text.match(/https?:\/\/[^\s"'<>`]+/gi) || []
  for (const raw of found) {
    for (const candidate of [raw, raw.replace(/[).,;:!?\]]+$/, '')]) {
      const href = httpUrl(candidate)
      if (href) out.add(href)
    }
  }
  return out
}

function makePage(handle, opts = {}) {
  const ctx = opts.ctx
  if (!ctx || typeof ctx !== 'object') throw new TypeError('makePage: opts.ctx is required')
  if (!handle || typeof handle.onMessage !== 'function' || typeof handle.post !== 'function') {
    throw new TypeError('makePage: needs an html overlay handle (post, onMessage)')
  }
  // Fail closed: an older app with no onConnect is holder mode, never an owner default.
  const perView = typeof handle.onConnect === 'function'
  const holderAccess = ACCESS.includes(opts.holderAccess) ? opts.holderAccess : 'read'
  const log =
    typeof opts.log === 'function'
      ? opts.log
      : (text) => {
          try {
            ctx.log.warn(text)
          } catch {
            // nowhere left to say it
          }
        }
  const project = typeof opts.project === 'function' ? opts.project : (state) => state
  const guestError = typeof opts.guestError === 'string' && opts.guestError ? opts.guestError : GUEST_ERROR
  const ids = opts.tabs && Array.isArray(opts.tabs.ids) ? opts.tabs.ids.filter((id) => typeof id === 'string' && TAB_ID.test(id)) : ['details', 'ask']
  const first = opts.tabs && ids.includes(opts.tabs.first) ? opts.tabs.first : ids.includes('ask') ? 'ask' : ids[0] || ''

  const copies = new Map() // copy id -> { copy, from, greeted }
  const listeners = new Set()
  const offs = []
  let phase = 'loading' // 'loading' | 'failed' | 'ready'
  let state
  let documentText = ''
  let failure = null // { message, retry }
  let lastTab = null
  let chunkSeq = 0
  let disposed = false

  // The owner's last used tab, read once; a copy is greeted after it (so its first tab is the right one).
  const tabRead = Promise.resolve()
    .then(() => ctx.appStorage.get(TAB_KEY))
    .then(
      (v) => {
        if (typeof v === 'string' && ids.includes(v) && lastTab === null) lastTab = v
      },
      (e) => log(`kit: last used tab not read: ${e && e.message}`)
    )

  const send = (c, message) => {
    try {
      if (perView) handle.post(message, { copy: c.copy })
      else handle.post(message)
      return true
    } catch (e) {
      log(`kit: post to a copy: ${e && e.message}`)
      return false
    }
  }
  const tabFor = (from) => {
    if (from.access === 'owner') return lastTab || first
    if (from.access === 'write') return ids.includes('ask') ? 'ask' : first
    return ids.includes('details') ? 'details' : first
  }
  const failedFor = (c) => ({
    type: 'cc-kit.failed',
    message: c.from.access === 'owner' ? failure.message : guestError,
    retry: c.from.access === 'owner' && typeof failure.retry === 'function',
  })
  const stateTo = (c) => {
    let projected
    try {
      projected = project(state, c.from)
    } catch (e) {
      // Fail closed: a projection that throws sends nothing of the state.
      log(`kit: project() threw: ${e && e.message}`)
      return send(c, { type: 'cc-kit.failed', message: c.from.access === 'owner' ? 'This could not be shown.' : guestError, retry: false })
    }
    if (projected === undefined) return false
    const message = { type: 'cc-kit.state', state: projected }
    const whole = JSON.stringify(message)
    if (whole.length <= MESSAGE_CHARS) return send(c, message)
    const text = JSON.stringify(projected)
    const n = Math.ceil(text.length / CHUNK_CHARS)
    if (n > MAX_CHUNKS) {
      log(`kit: a state of ${text.length} characters is too large to send`)
      return send(c, { type: 'cc-kit.failed', message: c.from.access === 'owner' ? 'This is too large to show.' : guestError, retry: false })
    }
    const id = ++chunkSeq
    for (let i = 0; i < n; i++) {
      if (!send(c, { type: 'cc-kit.chunk', id, i, n, text: text.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS) })) return false
    }
    return true
  }
  const phaseTo = (c) => {
    if (phase === 'loading') return send(c, { type: 'cc-kit.loading' })
    if (phase === 'failed') return send(c, failedFor(c))
    return stateTo(c)
  }
  const greet = (c) => {
    tabRead.then(() => {
      if (disposed || copies.get(c.copy) !== c) return
      c.greeted = true
      send(c, { type: 'cc-kit.init', access: c.from.access, tab: tabFor(c.from) })
      phaseTo(c)
    })
  }
  const greeted = () => [...copies.values()].filter((c) => c.greeted)

  const kitMessage = (m, from) => {
    if (m.type === 'cc-kit.link') {
      const href = httpUrl(m.url)
      // Fail closed: only a URL of the document this page holds, never one the page made up.
      if (!href || !urlsIn(documentText).has(href)) {
        log('kit: a link not in the document was not opened')
        return
      }
      Promise.resolve()
        .then(() => ctx.openExternal(href, { view: from.view }))
        .catch((e) => log(`kit: link not opened: ${e && e.message}`))
    } else if (m.type === 'cc-kit.tab') {
      if (from.access !== 'owner' || typeof m.tab !== 'string' || !ids.includes(m.tab)) return
      lastTab = m.tab
      Promise.resolve()
        .then(() => ctx.appStorage.set(TAB_KEY, m.tab))
        .catch((e) => log(`kit: last used tab not kept: ${e && e.message}`))
    } else if (m.type === 'cc-kit.retry') {
      if (from.access !== 'owner' || phase !== 'failed' || !failure || typeof failure.retry !== 'function') return
      try {
        failure.retry()
      } catch (e) {
        log(`kit: retry threw: ${e && e.message}`)
      }
    }
  }

  const on = (fn) => {
    const off = fn()
    if (typeof off === 'function') offs.push(off)
  }
  // Holder mode: who posted, as far as the app says (its `from.access` when it fills one), else the holder's access.
  const holder = perView ? null : { copy: HOLDER, from: { view: '', access: holderAccess, copy: HOLDER }, greeted: false }
  const holderFrom = (from) => ({
    view: from && typeof from === 'object' && typeof from.view === 'string' ? from.view : '',
    access: from && typeof from === 'object' && ACCESS.includes(from.access) ? from.access : holderAccess,
    copy: HOLDER,
  })
  if (holder) copies.set(HOLDER, holder)

  if (perView) {
    on(() =>
      handle.onConnect((from) => {
        const v = viewerOf(from)
        if (!v || copies.has(v.copy)) return
        const c = { copy: v.copy, from: v, greeted: false }
        copies.set(c.copy, c)
        greet(c)
      })
    )
  }
  if (perView && typeof handle.onDisconnect === 'function') {
    on(() =>
      handle.onDisconnect((from) => {
        if (from && typeof from.copy === 'string') copies.delete(from.copy)
      })
    )
  }
  on(() =>
    handle.onMessage((m, from) => {
      const v = perView ? viewerOf(from) : holderFrom(from)
      if (!v || !copies.has(v.copy)) return
      if (m && typeof m === 'object' && m.type === 'cc-kit.hello') {
        // The page loaded (or reloaded): holder mode greets it now; a perView copy was greeted on its connect.
        if (holder) greet(holder)
        return
      }
      if (m && typeof m === 'object' && typeof m.type === 'string' && m.type.startsWith('cc-kit.')) {
        kitMessage(m, v)
        return
      }
      for (const fn of [...listeners]) {
        try {
          fn(m, v)
        } catch (e) {
          log(`kit: a message listener threw: ${e && e.message}`)
        }
      }
    })
  )

  return {
    set(next, setOpts = {}) {
      state = next
      phase = 'ready'
      failure = null
      documentText = typeof setOpts.document === 'string' ? setOpts.document : JSON.stringify(next) || ''
      for (const c of greeted()) stateTo(c)
    },
    loading() {
      phase = 'loading'
      failure = null
      for (const c of greeted()) send(c, { type: 'cc-kit.loading' })
    },
    fail(message, failOpts = {}) {
      phase = 'failed'
      failure = { message: typeof message === 'string' ? message : 'This could not be loaded.', retry: failOpts.retry }
      for (const c of greeted()) send(c, failedFor(c))
    },
    post(copy, message) {
      const c = copies.get(copy)
      return c ? send(c, message) : false
    },
    each(message) {
      for (const c of greeted()) send(c, typeof message === 'function' ? message({ copy: c.copy, from: c.from }) : message)
    },
    copies() {
      return [...copies.values()].map((c) => ({ copy: c.copy, from: c.from }))
    },
    onMessage(fn) {
      if (typeof fn !== 'function') throw new TypeError('onMessage needs a function')
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    dispose() {
      disposed = true
      for (const off of offs.splice(0)) {
        try {
          off()
        } catch {
          // already gone
        }
      }
      copies.clear()
      listeners.clear()
    },
  }
}

module.exports = { makePage, urlsIn, CHUNK_CHARS, MESSAGE_CHARS, MAX_CHUNKS, HOLDER }
