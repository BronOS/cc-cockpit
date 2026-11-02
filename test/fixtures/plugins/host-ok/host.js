// Fixture plugin for the plugin-host e2e: records what it saw at activation in $HOME (a temp dir
// in the e2e run) so the test can check the host's environment and ctx from outside.
const fs = require('node:fs')
const path = require('node:path')

exports.activate = (ctx) => {
  fs.writeFileSync(
    path.join(process.env.HOME, 'host-ok.json'),
    JSON.stringify({ pluginId: ctx.pluginId, api: ctx.api, envKeys: Object.keys(process.env).sort() })
  )
  ctx.log.info('activated')
}
