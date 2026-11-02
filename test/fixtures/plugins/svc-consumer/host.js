// Fixture consumer for the plugin-services e2e: uses service "greet" v1. It reports to
// $HOME/svc-consumer.json (a temp dir in the e2e run, like host-ctx): the command "call" calls
// greet('world') and records the answer or the error text; the "greeted" events it hears are
// recorded too. The file is rewritten at activate, so a test can tell a fresh host from an old one.
const fs = require('node:fs')
const path = require('node:path')

exports.activate = (ctx) => {
  const file = path.join(process.env.HOME, 'svc-consumer.json')
  const seen = { calls: [], events: [] }
  const save = () => fs.writeFileSync(file, JSON.stringify(seen))
  const greet = ctx.services.use('greet')
  greet.on('greeted', (data) => {
    seen.events.push(data)
    save()
  })
  ctx.commands.register('call', async () => {
    try {
      seen.calls.push({ ok: true, value: await greet.greet('world') })
    } catch (err) {
      seen.calls.push({ ok: false, error: String(err && err.message ? err.message : err) })
    }
    save()
  })
  save()
}
