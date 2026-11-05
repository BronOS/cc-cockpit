// design-next §3 fixture (Task 14 e2e, test/e2e/overlay-toolbar.spec.ts). Every outcome is told
// through ctx.notify, which the e2e reads from the recorded notifications.
//   manual   an html overlay with `ready: 'manual'`; its page calls ccPanel.ready() on { go }
//   release  posts { go } to that page
//   opener   an html overlay with two opener buttons and no type: "Ping" notifies, "Rename"
//            relabels Ping through setButtons; no onDiscuss, so no Discuss button
//   thing    an html overlay of the type `e2e-thing` with an onDiscuss handler (context text); the
//            test.typebuttons fixture adds its type buttons. Its result is told as `thing <json>`.
exports.activate = (ctx) => {
  let manual = null
  ctx.commands.register('manual', () => {
    manual = ctx.overlay.start({ kind: 'html', file: 'page.html', title: 'Manual page', ready: 'manual' })
    manual.result.then((r) => ctx.notify(`manual ${JSON.stringify(r)}`))
  })
  ctx.commands.register('release', () => {
    if (manual) manual.post({ go: true })
  })
  ctx.commands.register('opener', () => {
    const handle = ctx.overlay.start({
      kind: 'html',
      file: 'page.html',
      title: 'Opener page',
      buttons: [
        { id: 'ping', label: 'Ping' },
        { id: 'rename', label: 'Rename' }
      ]
    })
    handle.onButton('ping', () => ctx.notify('ping clicked'))
    handle.onButton('rename', () => {
      handle.setButtons([
        { id: 'ping', label: 'Pong', primary: true },
        { id: 'rename', label: 'Renamed', disabled: true }
      ])
    })
    handle.result.then((r) => ctx.notify(`opener ${JSON.stringify(r)}`))
  })
  ctx.commands.register('thing', () => {
    const handle = ctx.overlay.start({
      kind: 'html',
      file: 'page.html',
      title: 'Thing',
      type: { name: 'e2e-thing', data: { id: 't1' } }
    })
    handle.onDiscuss(() => ({ text: 'context from the opener' }))
    handle.result.then((r) => ctx.notify(`thing ${JSON.stringify(r)}`))
  })
}
