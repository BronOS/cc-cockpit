// qa-chloe verify fixture: a plugin hidden from guests (the default) whose every surface carries a
// QAZX marker: name, panel title, command title, header meta, badge, panel posts, notices and an
// html overlay opened by a command (no tab origin). A guest must never receive "QAZX" or the id.
exports.activate = (ctx) => {
  ctx.panels.header('box', { meta: 'QAZX-header' })
  ctx.badge('box', 7)
  ctx.commands.register('ping', async () => {
    ctx.panels.post('box', { m: 'QAZX-post' })
    ctx.notify('QAZX-notify')
    ctx.overlay.start({ kind: 'html', title: 'QAZX-overlaytitle', file: 'panel.html' })
  })
}
