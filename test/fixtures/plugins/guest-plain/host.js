// Guest e2e fixture (task 07b, D-17): a plugin that is NOT guest-aware (no `guests` in its manifest) and
// checks nobody: it counts every Bump it gets and tells every page. Shown to guests, a read-only guest's
// port is one-way (main drops what that page posts), so the count never moves from a read guest's click;
// a write guest's click counts like the owner's.
let count = 0
exports.activate = (ctx) => {
  ctx.panels.onMessage('counter', (message) => {
    if (message && message.bump) count++
    ctx.panels.post('counter', { count })
  })
}
