// Guest e2e fixture (task 07b, spec-review item 29): a guest-aware stand-in for the Team plugin. It
// declares `"guests": { "aware": true }` and keeps its promise: every answer depends on main's port tag
// (`from.access`), never on what the page says. The owner sees the owner-only line; a guest sees the
// shared board; a read-only guest's `add` is refused, a write guest's lands on the board for everyone.
const items = []
exports.activate = (ctx) => {
  const board = () => ({ items: [...items] })
  ctx.panels.onMessage('board', (message, from) => {
    if (message && message.hello) {
      const who = from.access === 'owner' ? 'OWNER-ONLY team settings' : `guest view (${from.access})`
      ctx.panels.post('board', { who, ...board() }, { view: from.view })
      return
    }
    if (message && typeof message.add === 'string') {
      if (from.access === 'read') {
        ctx.panels.post('board', { refused: message.add }, { view: from.view })
        return
      }
      items.push(`${message.add} (${from.access})`)
      ctx.panels.post('board', board())
    }
  })
}
