// Web access e2e fixture (web-access-plugins.spec.ts): the panel asks for a link by name and the
// host opens the URL it chose with ctx.openExternal (a plugin never opens a URL taken from its page).
// A notification says when main took the call, so the spec can wait for it without touching the
// browser's page (a Playwright check there runs as a user gesture).
const LINKS = { a: 'https://example.com/clicked', b: 'https://example.com/unasked' }
exports.activate = (ctx) => {
  ctx.panels.onMessage('links', (message) => {
    const url = LINKS[message && message.open]
    if (!url) return
    ctx.openExternal(url).then(
      () => ctx.notify(`asked ${message.open}`),
      (err) => ctx.notify(`failed ${err.message}`)
    )
  })
}
