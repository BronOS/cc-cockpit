// Task 14 fixture (shared/design-parts.md §1-§2): a part plugin. It listens for the overlay-notes fixture's announce
// (kind `fixture.doc`, opener test.overlaynotes) and attaches its own part, part.html, beside that overlay's page: the
// refs it heard and the title main gave go to each copy at connect, and its onDiscuss text goes into the parent's
// Discuss. A refusal (no announce, a second part, an older app) is a notification, never a throw. On an app without
// parts it does nothing.
const KIND = 'fixture.doc'
const OPENER = 'test.overlaynotes'

exports.activate = (ctx) => {
  if (typeof ctx.overlay.onAnnounce !== 'function' || typeof ctx.overlay.part !== 'function') return
  /** Overlays this plugin has a part in: a second announce of one overlay attaches nothing more. */
  const attached = new Set()
  ctx.overlay.onAnnounce(KIND, (a) => {
    // The refs are the opener's data: only the fixture's own opener, and refs that look like what it sends.
    if (a.overlay.opener !== OPENER || attached.has(a.overlay.id)) return
    const refs = a.refs.filter((r) => /^[a-z]+:[A-Za-z0-9-]+$/.test(r))
    attached.add(a.overlay.id)
    const part = ctx.overlay.part(a.overlay.id, { file: 'part.html', title: 'Overlay part' })
    part.onConnect((from) => part.post({ refs, title: a.overlay.title, access: from.access }, { copy: from.copy }))
    part.onDiscuss(() => ({ text: `Part refs: ${refs.join(', ')}` }))
    part.result
      .then((result) => ctx.notify(`part ${JSON.stringify(result)}`))
      .catch((err) => ctx.notify(`part refused: ${err.message}`))
      .finally(() => attached.delete(a.overlay.id))
  })
}
