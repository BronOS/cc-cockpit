// Fixture plugin for the panel header e2e (ctx.panels.header / onAction): a meta text and three
// actions (a core icon, its own .svg, another core icon) on its panel. Refresh turns busy (and
// stays so: its click must not come again), Clear sets null. Every click it hears is recorded in
// $HOME/panel-header.json (a temp dir in the e2e run), in order.
const fs = require('node:fs')
const path = require('node:path')

exports.activate = (ctx) => {
  const file = path.join(process.env.HOME, 'panel-header.json')
  const clicks = []
  const save = () => fs.writeFileSync(file, JSON.stringify({ clicks }))
  const header = (busy) =>
    ctx.panels.header('board', {
      meta: 'synced just now, 3 items open in this board',
      actions: [
        { id: 'refresh', icon: 'refresh', title: 'Refresh', busy },
        { id: 'star', icon: 'icons/star.svg', title: 'Star' },
        { id: 'clear', icon: 'check', title: 'Clear header' }
      ]
    })
  header(false)
  ctx.panels.onAction('board', (id) => {
    clicks.push(id)
    save()
    if (id === 'refresh') header(true)
    if (id === 'clear') ctx.panels.header('board', null)
  })
  save()
}
