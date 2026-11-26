// Review S-5 fixture: a second part plugin, as overlay-part (read that one) under its own id and title, so one
// overlay-notes window holds two parts: closing the first must never reload the second's page.
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
    const part = ctx.overlay.part(a.overlay.id, { file: 'part.html', title: 'Overlay part B' })
    part.onConnect((from) => part.post({ refs, title: a.overlay.title, access: from.access }, { copy: from.copy }))
    part.onDiscuss(() => ({ text: `Part refs: ${refs.join(', ')}` }))
    part.result
      .then((result) => ctx.notify(`part ${JSON.stringify(result)}`))
      .catch((err) => ctx.notify(`part refused: ${err.message}`))
      .finally(() => attached.delete(a.overlay.id))
  })
}
