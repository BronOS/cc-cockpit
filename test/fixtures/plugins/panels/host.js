// Task 28 fixture: echoes what its panel posts (with this host's pid, so a test can tell a restarted
// host from the old one), and opens its own html page as an overlay whose
// `{ result }` it reports through ctx.notify (the e2e reads the recorded notifications).
exports.activate = (ctx) => {
  ctx.panels.onMessage('echo', (message) => ctx.panels.post('echo', { echo: message, pid: process.pid }))
  ctx.commands.register('pick', () => {
    ctx.overlay
      .open({ kind: 'html', file: 'pick.html', title: 'Pick' })
      .then((result) => ctx.notify(`picked ${JSON.stringify(result)}`))
      .catch((err) => ctx.notify(`pick failed: ${err.message}`))
  })
}
