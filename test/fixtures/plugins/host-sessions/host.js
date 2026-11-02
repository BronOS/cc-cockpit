// Fixture plugin for the sessions/badge e2e (Task 27): badges its panel, opens a Claude tab with a
// prompt, lists the window's sessions, and records what it saw (and what was refused) in $HOME (a
// temp dir in the e2e run).
const fs = require('node:fs')
const path = require('node:path')

exports.activate = async (ctx) => {
  const seen = {}
  try {
    ctx.badge('board', 3)
    try {
      ctx.badge('other', 1)
    } catch (err) {
      seen.badgeError = err.message
    }
    seen.opened = await ctx.sessions.open({ prompt: '-p from the plugin' })
    seen.list = await ctx.sessions.list()
    try {
      await ctx.sessions.open({ cwd: '..' })
    } catch (err) {
      seen.outsideError = err.message
    }
  } catch (err) {
    seen.error = String(err && err.stack ? err.stack : err)
  }
  fs.writeFileSync(path.join(process.env.HOME, 'host-sessions.json'), JSON.stringify(seen))
}
