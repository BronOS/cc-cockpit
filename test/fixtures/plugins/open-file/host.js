// Fixture for the open-file e2e (sessions-panel.spec.ts): takes Sessions panel file clicks with
// ctx.files.onOpen and records each request in $HOME/open-file.json (a temp dir in the e2e run).
// The file is rewritten at activate, so a test can tell the host is up. A file whose name starts
// with "fail" makes the listener throw, so the app must fall back to its built-in viewer.
const fs = require('node:fs')
const path = require('node:path')

exports.activate = (ctx) => {
  const file = path.join(process.env.HOME, 'open-file.json')
  const seen = []
  const save = () => fs.writeFileSync(file, JSON.stringify(seen))
  ctx.files.onOpen((req) => {
    if (path.basename(req.path).startsWith('fail')) throw new Error('fixture refuses ' + req.path)
    seen.push({ path: req.path, tabId: req.tabId })
    save()
  })
  save()
}
