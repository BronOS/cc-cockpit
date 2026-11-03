// Fixture plugin for the ctx e2e (Task 26): uses settings, storage, dataDir, appStorage, appDataDir,
// exec, notify (title, sound, an action clicked by the e2e), log and a command in the real plugin host, and records what it saw in $HOME (a temp dir in the e2e run).
const fs = require('node:fs')
const path = require('node:path')

exports.activate = async (ctx) => {
  const seen = { settings: ctx.settings }
  try {
    await ctx.storage.set('answer', { n: 42 })
    seen.stored = await ctx.storage.get('answer')
    seen.dataDir = ctx.dataDir
    fs.writeFileSync(path.join(ctx.dataDir, 'hello.txt'), 'written in dataDir')
    // App-wide, through main: the second increment sees the first.
    await ctx.appStorage.set('app', { shared: true })
    seen.appStored = await ctx.appStorage.get('app')
    seen.counted = [await ctx.appStorage.increment('runs'), await ctx.appStorage.increment('runs', 2)]
    try {
      await ctx.appStorage.increment('app')
    } catch (err) {
      seen.incrementError = err.message
    }
    seen.appDataDir = ctx.appDataDir
    fs.writeFileSync(path.join(ctx.appDataDir, 'hello.txt'), 'written in appDataDir')
    // sh -c with the payload as $1: if anything went through a shell, the output would be "in" + "pwned".
    seen.exec = await ctx.exec(['sh', '-c', 'cat; printf "%s" "$1"', 'sh', '$(echo pwned)'], { stdin: 'in:' })
    await ctx.notify('hello from the fixture plugin')
    // A title and the plugin's own sound (a "format": "sound" setting's value); resolves at once (no action).
    seen.soundNotify = await ctx.notify('chime please', { title: 'Fixture reminder', sound: 'builtin:bell' })
    // An action: waits for the e2e's click (clickNotification), then records what it got.
    void ctx.notify('Standup in 2 min', { title: 'Calendar', action: { label: 'Join' } }).then((result) => {
      fs.writeFileSync(path.join(process.env.HOME, 'notify-click.json'), JSON.stringify(result))
    })
    ctx.log.info('fixture log line')
    ctx.commands.register('ping', () => {
      fs.writeFileSync(path.join(ctx.dataDir, 'ping.txt'), 'pong')
    })
    try {
      ctx.commands.register('undeclared', () => {})
    } catch (err) {
      seen.undeclaredError = err.message
    }
  } catch (err) {
    seen.error = String(err && err.stack ? err.stack : err)
  }
  fs.writeFileSync(path.join(process.env.HOME, 'host-ctx.json'), JSON.stringify(seen))
}
