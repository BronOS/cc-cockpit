// `beside` fixture (test/e2e/split-plugin.spec.ts; design.md §1 "Plugin API", D4, D6, D7). The test
// writes the anchor tab's id to $HOME/anchor.txt; each command opens one tab beside it with
// `focus: true` (a plugin-opened pane must still never take focus, D4) and appends what came back, or
// the error, as one JSON line to $HOME/beside.log. The result's `placed` is passed through untouched.
const fs = require('node:fs')
const path = require('node:path')

const home = process.env.HOME
const anchor = () => fs.readFileSync(path.join(home, 'anchor.txt'), 'utf8').trim()
const log = (entry) => fs.appendFileSync(path.join(home, 'beside.log'), JSON.stringify(entry) + '\n')

exports.activate = (ctx) => {
  const run = (name, open) =>
    ctx.commands.register(name, async () => {
      try {
        log({ command: name, result: await open() })
      } catch (err) {
        log({ command: name, error: String(err && err.message) })
      }
    })
  run('open-command', () =>
    ctx.sessions.openCommand({
      argv: ['sh', '-c', 'echo "plug-$((3+4))"; sleep 120'],
      title: 'Plug',
      focus: true,
      beside: anchor()
    })
  )
  run('open-shell-down', () => ctx.sessions.openShell({ focus: true, beside: anchor(), side: 'down' }))
  run('open-unknown', () => ctx.sessions.openShell({ beside: 'no-such-tab-id' }))
}
