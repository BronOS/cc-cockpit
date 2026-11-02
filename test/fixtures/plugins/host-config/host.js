// Fixture plugin for the `ccc plugin config` e2e (friction round 1, Task 6): writes the settings it
// starts with, and every change it is told of, to $HOME/host-config.json (a temp dir in the e2e run).
const fs = require('node:fs')
const path = require('node:path')

exports.activate = (ctx) => {
  const file = path.join(process.env.HOME, 'host-config.json')
  const seen = { start: ctx.settings, changes: [] }
  fs.writeFileSync(file, JSON.stringify(seen))
  ctx.onSettingsChange((settings) => {
    seen.changes.push(settings)
    fs.writeFileSync(file, JSON.stringify(seen))
  })
}
