'use strict'
// Sessions for cc-cockpit (design-next §4.2): the Claude status view that used to be built into the
// renderer, on the public plugin API only.
//
// - Panel `sessions`: a card per Claude tab of THIS window (ctx.sessions.list / onChange), with the
//   header meta "N in this window". A card click selects the tab (ctx.sessions.focus), a changed
//   file opens through ctx.sessions.openFile (main checks the file is one it recorded for the tab).
// - Slot `sessions-strip` (the app's top bar): the OTHER windows' Claude tabs, from the scope `all`
//   summaries (plugin.json declares `"access": { "sessions": "all-windows" }`), which carry status,
//   tool, title, name and the project only. A click raises that window at the tab.
//
// The pages only draw and ask; the host keeps the lists and checks every id a page sends against
// them before it calls ctx (the pages are ours, but a bug there must not focus a random id).

const view = require('./lib/view')

const PANEL = 'sessions'
const STRIP = 'sessions-strip'

let disposers = []

exports.activate = (ctx) => {
  /** This window's Claude tabs (SessionInfo[]), as last heard. */
  let own = []
  /** Every window's Claude tabs (SessionSummary[]), as last heard. */
  let all = []
  /** The open strip frames (one per window's top bar, but a remount may overlap the old one). */
  const strips = new Set()
  let lastMeta = null

  const filesShown = () => view.filesShownOf((ctx.settings.app || {}).filesShown)

  const postPanel = (m) => {
    try {
      ctx.panels.post(PANEL, m)
    } catch (e) {
      ctx.log.warn(`post: ${e.message}`)
    }
  }

  function sendPanel() {
    postPanel({ type: 'sessions', sessions: own, filesShown: filesShown() })
    const meta = view.metaText(own.length) ?? null
    if (meta === lastMeta) return
    lastMeta = meta
    try {
      ctx.panels.header(PANEL, meta === null ? null : { meta })
    } catch (e) {
      ctx.log.warn(`header: ${e.message}`)
    }
  }

  function sendStrip(slot) {
    try {
      slot.post({ type: 'strip', entries: view.stripView(all) })
    } catch (e) {
      ctx.log.warn(`strip post: ${e.message}`)
    }
  }
  const sendStrips = () => {
    for (const slot of strips) sendStrip(slot)
  }

  async function focus(tabId, known) {
    // Only an id the page could have drawn: the panel's own tabs, or the strip's other windows.
    if (typeof tabId !== 'string' || !known.some((s) => s.tabId === tabId)) return false
    return ctx.sessions.focus(tabId)
  }

  // ---- this window ----

  disposers.push(
    ctx.sessions.onChange((sessions) => {
      own = sessions
      sendPanel()
    }),
  )
  ctx.sessions
    .list()
    .then((sessions) => {
      own = sessions
      sendPanel()
    })
    .catch((e) => ctx.log.warn(`list: ${e.message}`))

  disposers.push(
    ctx.panels.onMessage(PANEL, async (m) => {
      if (!m || typeof m !== 'object') return
      try {
        if (m.type === 'hello') {
          sendPanel()
        } else if (m.type === 'focus') {
          await focus(m.tabId, own)
        } else if (m.type === 'openFile') {
          const session = own.find((s) => s.tabId === m.tabId)
          // The page shows only files of the list it was sent; anything else is refused here
          // without a call (main would refuse it too).
          if (!session || typeof m.path !== 'string' || !session.files.includes(m.path)) {
            postPanel({ type: 'refused', tabId: m.tabId, path: m.path })
            return
          }
          try {
            await ctx.sessions.openFile(m.tabId, m.path)
          } catch (e) {
            ctx.log.warn(`openFile: ${e.message}`)
            postPanel({ type: 'refused', tabId: m.tabId, path: m.path })
          }
        }
      } catch (e) {
        ctx.log.warn(`${m.type}: ${e.message}`)
      }
    }),
  )

  // ---- other windows ----

  disposers.push(
    ctx.sessions.onChange(
      (summaries) => {
        all = summaries
        sendStrips()
      },
      { scope: 'all' },
    ),
  )
  ctx.sessions
    .list({ scope: 'all' })
    .then((summaries) => {
      all = summaries
      sendStrips()
    })
    .catch((e) => ctx.log.warn(`list all: ${e.message}`))

  disposers.push(
    ctx.slots.onOpen(STRIP, (slot) => {
      strips.add(slot)
      slot.onMessage(async (m) => {
        if (!m || typeof m !== 'object') return
        try {
          if (m.type === 'hello') sendStrip(slot)
          else if (m.type === 'focus') await focus(m.tabId, view.stripView(all))
        } catch (e) {
          ctx.log.warn(`strip ${m.type}: ${e.message}`)
        }
      })
      slot.onClose(() => strips.delete(slot))
      sendStrip(slot)
    }),
  )

  disposers.push(ctx.onSettingsChange(() => sendPanel()))

  ctx.log.info('activated')
}

exports.deactivate = () => {
  for (const d of disposers) {
    try {
      if (typeof d === 'function') d()
    } catch {
      // nothing left to clean up in a reloading host
    }
  }
  disposers = []
}
