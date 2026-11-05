'use strict'
// The pure part of the Sessions plugin: what a card and the strip show, from the rows ctx.sessions
// gives. No DOM and no ctx here, so every rule runs under node:test. Shared by the host (require) and
// both pages (a classic <script src="/dist/lib/view.js">, which sets the global `ccSessionsView`):
// one copy of the order, the labels and the file cap, never a page's own idea of them.
//
// Everything here is text from hooks, Claude's terminal title or another window's project: the pages
// put it in the DOM as textContent only, never as markup.
;(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.ccSessionsView = api
})(typeof globalThis === 'object' ? globalThis : this, function () {
  /** The app setting `filesShown` (plugin.json): range and default, as the old core setting had. */
  const FILES_SHOWN = { min: 1, max: 500, default: 10 }

  /**
   * What needs the person first: a permission prompt or a question / plan dialog (both
   * `needs-permission`), then waiting for input, then busy, then quiet; `starting` is as quiet as
   * idle, `ended` last. The core strip's order (renderer strip-order.ts), kept so the move is invisible.
   */
  const RANK = { 'needs-permission': 0, waiting: 1, working: 2, idle: 3, starting: 3, ended: 4 }

  const LABEL = {
    starting: 'starting',
    idle: 'idle',
    working: 'working',
    'needs-permission': 'needs permission',
    waiting: 'waiting for input',
    ended: 'ended'
  }

  /** A dialog tool's `needs-permission` is Claude asking the person, not a permission prompt. */
  const DIALOG_WORD = { AskUserQuestion: 'question', ExitPlanMode: 'plan approval' }

  /** The stored setting, default applied: settings.json is user-writable, so a bad value is the default, never "show none". */
  function filesShownOf(stored) {
    return Number.isInteger(stored) && stored >= FILES_SHOWN.min && stored <= FILES_SHOWN.max ? stored : FILES_SHOWN.default
  }

  /** `status · tool` (the tool only while there is one); a dialog tool's as `needs you · <dialog>`. */
  function statusText(status, tool) {
    if (status === 'needs-permission' && typeof tool === 'string' && Object.hasOwn(DIALOG_WORD, tool)) {
      return `needs you · ${DIALOG_WORD[tool]}`
    }
    const label = Object.hasOwn(LABEL, status) ? LABEL[status] : String(status)
    return typeof tool === 'string' && tool !== '' ? `${label} · ${tool}` : label
  }

  /** A changed file split at its last slash, so the name can stand out from its folder. */
  function splitPath(file) {
    const cut = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')) + 1
    return { dir: file.slice(0, cut), name: file.slice(cut) }
  }

  /**
   * One card of the panel. `index` is the tab's 1-based place among this window's Claude tabs: until
   * Claude names it, the card reads "Claude N" (tab labels carry no number, nothing stabler matches).
   * `showAll`: the person pressed Show all on this card. The gist (the core setting's one-line
   * summary) stands in for the last prompt, which stays the tooltip.
   */
  function cardView(session, { index = 1, filesShown = FILES_SHOWN.default, showAll = false } = {}) {
    const cap = filesShownOf(filesShown)
    const files = Array.isArray(session.files) ? session.files.filter((f) => typeof f === 'string') : []
    const label = session.name || session.title || `Claude ${index}`
    const card = {
      tabId: session.tabId,
      status: session.status,
      label,
      tooltip: session.name || session.title ? `${label}\nGo to this tab` : 'Go to this tab',
      statusText: statusText(session.status, session.tool),
      active: session.active === true,
      notes: Array.isArray(session.notes) ? session.notes.filter((n) => typeof n === 'string') : [],
      files: showAll ? files : files.slice(0, cap),
      fileCount: files.length,
      hiddenFiles: Math.max(0, files.length - cap)
    }
    if (typeof session.gist === 'string' && session.gist !== '') {
      card.summary = { text: session.gist, title: session.lastPrompt || session.gist, gist: true }
    } else if (typeof session.lastPrompt === 'string' && session.lastPrompt !== '') {
      card.summary = { text: session.lastPrompt, title: session.lastPrompt, gist: false }
    }
    const steps = session.steps
    if (steps && Number.isFinite(steps.done) && Number.isFinite(steps.total)) {
      // A total of 0 is an empty bar, a done past the total (the CLI takes both as given) a full one.
      const percent = steps.total > 0 ? Math.min(100, Math.max(0, (steps.done / steps.total) * 100)) : 0
      card.steps = { text: `${steps.done}/${steps.total}`, percent }
    }
    return card
  }

  /**
   * A project colour as main sends it: a palette token (`var(--cc-project-blue)`) or `#rrggbb`. Only
   * those two forms go into a style, so a damaged value can never carry more CSS than a colour.
   */
  function isColor(v) {
    return typeof v === 'string' && (/^var\(--cc-project-[a-z]{1,20}\)$/.test(v) || /^#[0-9a-fA-F]{6}$/.test(v))
  }

  /** The panel header's meta: "2 in this window", nothing with none (the body says so in words). */
  function metaText(count) {
    return count > 0 ? `${count} in this window` : undefined
  }

  /**
   * The strip: the OTHER windows' Claude tabs (this window's are in its own tab strip and the
   * panel), most urgent first, STABLE by the input order (the registry lists tabs in creation order,
   * so two tabs in the same state do not swap when a third changes). An empty list draws nothing.
   */
  function stripView(summaries) {
    if (!Array.isArray(summaries)) return []
    return summaries
      .filter((s) => s && typeof s === 'object' && s.own !== true && typeof s.tabId === 'string')
      .map((s, i) => ({ s, i }))
      .sort((a, b) => (RANK[a.s.status] ?? 3) - (RANK[b.s.status] ?? 3) || a.i - b.i)
      .map(({ s }) => {
        const project = s.project && typeof s.project.name === 'string' ? s.project.name : ''
        const status = statusText(s.status, s.tool)
        const topic = s.name || s.title
        const entry = {
          tabId: s.tabId,
          status: s.status,
          project,
          text: `${project} · ${status}`,
          tooltip: topic ? `${project} · ${topic}\n${status}` : `${project} · ${status}`,
          // Tinted: the entry that waits on the person stands out by its status colour, not only by weight.
          needsYou: s.status === 'needs-permission'
        }
        if (s.project && isColor(s.project.color)) entry.color = s.project.color
        return entry
      })
  }

  return { FILES_SHOWN, filesShownOf, isColor, statusText, splitPath, cardView, metaText, stripView }
})
