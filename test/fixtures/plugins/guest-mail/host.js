// Guest e2e fixture (task 07b, spec-review item 29): a Gmail-like plugin, never shown to guests (hidden is
// the default). Its page and its host's answers carry MARKER (marker.js); a guest must never receive it by
// any route: the socket, a port, a guessed /p/ address, a notice, an event.
const { MARKER } = require('./marker.js')
exports.activate = (ctx) => {
  ctx.panels.onMessage('inbox', () => ctx.panels.post('inbox', { subject: `Private mail ${MARKER}` }))
  ctx.notify(`new mail ${MARKER}`)
}
