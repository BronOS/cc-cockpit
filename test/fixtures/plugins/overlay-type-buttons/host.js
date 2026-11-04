// design-next §3.3 fixture: ctx.overlay.buttons for the `e2e-thing` type. Four buttons, so with an
// opener's four the toolbar folds into "…": "Mark" flips to "Unmark" after a click (main asks
// again once the click settled) and takes 300 ms (busy meanwhile); "Close it" answers
// { close: true }. Each run reports what it was told through ctx.notify (the e2e reads it).
exports.activate = (ctx) => {
  let marked = false
  ctx.overlay.buttons('e2e-thing', (o) => [
    {
      id: 'mark',
      label: marked ? 'Unmark' : 'Mark',
      run: async (info) => {
        await new Promise((resolve) => setTimeout(resolve, 300))
        marked = !marked
        ctx.notify(`ran mark on ${JSON.stringify(info.type.data)} from ${info.opener}`)
      }
    },
    { id: 'alpha', label: 'Alpha', run: () => ctx.notify('ran alpha') },
    { id: 'beta', label: 'Beta', disabled: o.type.data === null, run: () => ctx.notify('ran beta') },
    { id: 'close', label: 'Close it', run: () => ({ close: true }) }
  ])
}
