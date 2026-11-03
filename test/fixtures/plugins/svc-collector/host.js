// Fixture collector for the services-collect e2e: reads service "greet" v1 from every provider with
// ctx.services.useAll. It reports to $HOME/svc-collector.json: the command "collect" calls greet on
// each provider and records { from, value } per provider; every "greeted" event is recorded with the
// id of the plugin that sent it. Rewritten at activate, so a test can tell a fresh host.
const fs = require('node:fs')
const path = require('node:path')

exports.activate = (ctx) => {
  const file = path.join(process.env.HOME, 'svc-collector.json')
  const seen = { rounds: [], events: [] }
  const save = () => fs.writeFileSync(file, JSON.stringify(seen))
  const set = ctx.services.useAll('greet')
  set.on('greeted', (data, from) => {
    seen.events.push({ by: data.by, from })
    save()
  })
  ctx.commands.register('collect', async () => {
    const round = []
    for (const p of set.providers()) round.push({ from: p.pluginId, value: await p.handle.greet('all') })
    seen.rounds.push(round)
    save()
  })
  save()
}
