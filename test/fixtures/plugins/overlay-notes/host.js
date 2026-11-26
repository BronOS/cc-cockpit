// 00 contract fixture (shared/tasks/00-contract.md): a perView, guests.aware plugin whose overlay has a notes key,
// an onAsk and an onDiscuss handler. Its command opens the overlay; every copy gets the document at connect. Tasks 02,
// 03, 04, 05 and 07 drive it (Ask, notes, page-started Discuss, the e2e). On an app without the Notes or Ask API the
// page opens all the same (it feature-detects ccPanel.notes and ccPanel.ask).
const DOC = 'Fixture document: the quick brown fox. A second paragraph to select and ask about.'
const KEY = 'fixture:doc-1'

exports.activate = (ctx) => {
  ctx.commands.register('open', () => {
    const doc = ctx.overlay.start({ kind: 'html', file: 'doc.html', title: 'Overlay notes', notes: { key: KEY } })
    doc.onConnect((from) => doc.post({ doc: DOC, access: from.access }, { copy: from.copy }))
    doc.onDiscuss(() => ({ text: DOC }))
    if (typeof doc.onAsk === 'function') doc.onAsk(() => ({ text: DOC }))
    doc.onMessage((message) => ctx.notify(`heard ${JSON.stringify(message)}`))
    doc.result.then((result) => ctx.notify(`doc ${JSON.stringify(result)}`)).catch((err) => ctx.notify(`doc failed: ${err.message}`))
  })
  if (typeof ctx.notes === 'function') {
    ctx.commands.register('list', async () => {
      try {
        ctx.notify(`notes ${JSON.stringify(await ctx.notes(KEY).list())}`)
      } catch (err) {
        ctx.notify(`notes refused: ${err.message}`)
      }
    })
  }
}
