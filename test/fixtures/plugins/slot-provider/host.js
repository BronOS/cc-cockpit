// Fixture provider for the slots e2e: answers the ping of its slot pages with who it is and the params
// of the placement, and records every open, message and close in $HOME/slot-one.json (a temp dir in
// the e2e run), so a test can see what reached the provider and when a frame ended.
const fs = require('node:fs')
const path = require('node:path')

exports.activate = (ctx) => {
  const file = path.join(process.env.HOME, 'slot-one.json')
  const log = { opens: [], messages: [], closes: 0 }
  const save = () => fs.writeFileSync(file, JSON.stringify(log))
  const serve = (type) =>
    ctx.slots.onOpen(type, (slot) => {
      log.opens.push({ type: slot.type, host: slot.host, params: slot.params === undefined ? null : slot.params })
      save()
      slot.onMessage((message) => {
        log.messages.push({ type: slot.type, message })
        save()
        slot.post({ from: 'one', params: slot.params })
      })
      slot.onClose(() => {
        log.closes += 1
        save()
      })
    })
  serve('agenda')
  serve('sessions-strip')
  save()
}
