// Fixture plugin for session-takeover.spec.ts: `open` starts a Claude tab with model and effort,
// `send` sends one text to it through ctx.sessions.send. What each call returned or threw is
// written to $HOME/takeover.json (a temp dir in the e2e run).
const fs = require('node:fs')
const path = require('node:path')

exports.activate = (ctx) => {
  const out = path.join(process.env.HOME, 'takeover.json')
  const seen = {}
  const save = () => fs.writeFileSync(out, JSON.stringify(seen))
  let tabId
  ctx.commands.register('open', async () => {
    try {
      const opened = await ctx.sessions.open({ model: 'opus', effort: 'high' })
      tabId = opened.tabId
      seen.opened = opened
    } catch (err) {
      seen.openError = String(err && err.message)
    }
    save()
  })
  // Plain opens for the focus spec: no model, with and without focus.
  for (const [name, focus] of [['openBackground', false], ['openFocused', true]]) {
    ctx.commands.register(name, async () => {
      try {
        seen.opened = await ctx.sessions.open(focus ? { focus: true } : {})
      } catch (err) {
        seen.openError = String(err && err.message)
      }
      save()
    })
  }
  ctx.commands.register('send', async () => {
    try {
      seen.sent = await ctx.sessions.send(tabId, 'plugin text')
      delete seen.sendError
    } catch (err) {
      seen.sendError = String(err && err.message)
    }
    save()
  })
}
