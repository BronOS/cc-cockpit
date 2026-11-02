// Friction round 1 Task 13 fixture: ctx.overlay.start. The host posts { hello } right after start
// (before the page has loaded, so main queues it), answers each { n } the page posts with
// { ack: n } while the overlay stays open, and reports what it heard and the result through
// ctx.notify (the e2e reads the recorded notifications). A post after the end is a no-op.
exports.activate = (ctx) => {
  ctx.commands.register('chat', () => {
    const chat = ctx.overlay.start({ kind: 'html', file: 'chat.html', title: 'Chat' })
    chat.post({ hello: 'from host' })
    chat.onMessage((message) => {
      ctx.notify(`heard ${JSON.stringify(message)}`)
      if (typeof message.n === 'number') chat.post({ ack: message.n })
    })
    chat.result
      .then((result) => {
        chat.post({ late: true })
        ctx.notify(`chat ${JSON.stringify(result)}`)
      })
      .catch((err) => ctx.notify(`chat failed: ${err.message}`))
  })
}
