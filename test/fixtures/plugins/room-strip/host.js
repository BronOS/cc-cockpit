// Fixture plugin for rooms-strip.spec.ts: `open` makes a room and opens one member tab (bob) in it, `send` sends bob
// a message `from plugin`. What each call returned or threw is written to $HOME/room-strip.json (a temp dir in the e2e
// run).
const fs = require('node:fs')
const path = require('node:path')

exports.activate = (ctx) => {
  const out = path.join(process.env.HOME, 'room-strip.json')
  const seen = {}
  const save = () => fs.writeFileSync(out, JSON.stringify(seen))
  let roomId
  ctx.commands.register('open', async () => {
    try {
      roomId = (await ctx.rooms.create({ title: 'Strip test' })).id
      seen.opened = await ctx.rooms.open(roomId, { name: 'bob' })
    } catch (err) {
      seen.error = String(err && err.message)
    }
    save()
  })
  ctx.commands.register('send', async () => {
    try {
      seen.sent = await ctx.rooms.send(roomId, 'bob', 'hello bob')
    } catch (err) {
      seen.error = String(err && err.message)
    }
    save()
  })
}
