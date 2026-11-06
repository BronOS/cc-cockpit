// Fixture plugin for tab-flags.spec.ts: a plugin reads SessionInfo.flag and cannot write it.
// `read` records each tab's flag as ctx.sessions.list gives it; `tryWrite` looks for any ctx
// member named like a flag writer, mutates its own copy of the list and renames the tab with a
// flag riding along, then lists again. What it saw goes to $HOME/flag-reader.json (a temp dir in
// the e2e run).
const fs = require('node:fs')
const path = require('node:path')

exports.activate = (ctx) => {
  const out = path.join(process.env.HOME, 'flag-reader.json')
  const seen = { changes: [] }
  const save = () => fs.writeFileSync(out, JSON.stringify(seen))
  const flags = (list) => list.map((s) => (s.flag === undefined ? null : s.flag))
  ctx.sessions.onChange((list) => {
    seen.changes.push(flags(list))
    save()
  })
  ctx.commands.register('read', async () => {
    seen.list = flags(await ctx.sessions.list())
    save()
  })
  ctx.commands.register('tryWrite', async () => {
    // Every member of ctx and of its namespaces whose name mentions a flag (none should exist).
    const writers = []
    for (const [key, value] of Object.entries(ctx)) {
      if (/flag/i.test(key)) writers.push(`ctx.${key}`)
      if (value && typeof value === 'object') {
        for (const inner of Object.keys(value)) if (/flag/i.test(inner)) writers.push(`ctx.${key}.${inner}`)
      }
    }
    seen.writers = writers
    const [first] = await ctx.sessions.list()
    try {
      first.flag = { color: 'green', note: 'set by a plugin' }
    } catch {
      // a frozen copy is fine too
    }
    try {
      await ctx.sessions.rename(first.tabId, 'Renamed', { flag: { color: 'green' } })
    } catch (err) {
      seen.renameError = String(err && err.message)
    }
    seen.after = flags(await ctx.sessions.list())
    save()
  })
}
