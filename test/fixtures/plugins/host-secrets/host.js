// Fixture plugin for the ctx.secrets e2e: reads its secret, stores one the first time, and records
// what it saw in $HOME (a temp dir in the e2e run) so the spec can compare two app launches. Also
// records its project's secret settings field as ctx.settings has it at activate (a fixture: the
// spec needs the plaintext to tell that main decrypted it before the host started).
const fs = require('node:fs')
const path = require('node:path')

exports.activate = async (ctx) => {
  const seen = {}
  try {
    seen.settingToken = typeof ctx.settings.project.token === 'string' ? ctx.settings.project.token : null
    seen.before = await ctx.secrets.get('note')
    if (seen.before === null) await ctx.secrets.set('note', 'e2e-secret-plaintext')
    seen.after = await ctx.secrets.get('note')
    seen.keys = await ctx.secrets.keys()
    try {
      await ctx.secrets.set('setting:app:x', 'nope')
    } catch (err) {
      seen.reservedError = err.message
    }
  } catch (err) {
    seen.error = String(err && err.stack ? err.stack : err)
  }
  fs.writeFileSync(path.join(process.env.HOME, 'host-secrets.json'), JSON.stringify(seen))
}
