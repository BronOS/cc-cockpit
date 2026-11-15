// Fixture plugin for rooms-view.spec.ts: `open` makes a room and opens its members alice (coordinator) and bob, `doc`
// writes shared/plan.md, `send` sends bob a numbered message `from plugin`. What each call returned or threw is
// written to $HOME/room-view.json (a temp dir in the e2e run).
const fs = require('node:fs')
const path = require('node:path')

exports.activate = (ctx) => {
  const out = path.join(process.env.HOME, 'room-view.json')
  const seen = { sends: 0 }
  const save = () => fs.writeFileSync(out, JSON.stringify(seen))
  let roomId
  const guard = async (run) => {
    try {
      await run()
    } catch (err) {
      seen.error = String(err && err.message)
    }
    save()
  }
  ctx.commands.register('open', () =>
    guard(async () => {
      roomId = (await ctx.rooms.create({ title: 'View test' })).id
      seen.roomId = roomId
      seen.alice = await ctx.rooms.open(roomId, { name: 'alice', coordinator: true })
      seen.bob = await ctx.rooms.open(roomId, { name: 'bob' })
    })
  )
  ctx.commands.register('doc', () => guard(() => ctx.rooms.docs.put(roomId, 'shared/plan.md', 'kickoff plan\nstep two\n')))
  ctx.commands.register('send', () =>
    guard(async () => {
      seen.sends += 1
      await ctx.rooms.send(roomId, 'bob', `hello bob ${seen.sends}`)
    })
  )
}
