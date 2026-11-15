// Fixture plugin for rooms.spec.ts: `open` makes a room, seeds bob's kickoff doc and opens alice (coordinator), bob
// and carol; `work` gives carol a prompt through ctx.sessions.send (her turn starts); `to-carol` sends carol a message
// `from plugin`; `state` records the plugin's rooms and the first one's members (after a restart too, when the room
// id this host held is gone with it). What each call returned or threw is written to $HOME/rooms-test.json (a temp
// dir in the e2e run).
const fs = require('node:fs')
const path = require('node:path')

exports.activate = (ctx) => {
  const out = path.join(process.env.HOME, 'rooms-test.json')
  let seen = {}
  try {
    seen = JSON.parse(fs.readFileSync(out, 'utf8'))
  } catch {
    // first run
  }
  delete seen.error
  const save = () => fs.writeFileSync(out, JSON.stringify(seen))
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
      const roomId = (await ctx.rooms.create({ title: 'E2E room' })).id
      seen.roomId = roomId
      await ctx.rooms.docs.put(roomId, 'members/bob/kickoff.md', 'kickoff for bob\n')
      seen.alice = (await ctx.rooms.open(roomId, { name: 'alice', coordinator: true })).tabId
      seen.bob = (await ctx.rooms.open(roomId, { name: 'bob' })).tabId
      seen.carol = (await ctx.rooms.open(roomId, { name: 'carol' })).tabId
    })
  )
  ctx.commands.register('work', () => guard(async () => {
    seen.work = await ctx.sessions.send(seen.carol, 'start on the task')
  }))
  ctx.commands.register('to-carol', () => guard(async () => {
    seen.toCarol = await ctx.rooms.send(seen.roomId, 'carol', 'hello carol')
  }))
  ctx.commands.register('state', () =>
    guard(async () => {
      seen.rooms = await ctx.rooms.list()
      seen.members = seen.rooms[0] ? await ctx.rooms.members(seen.rooms[0].id) : []
    })
  )
}
