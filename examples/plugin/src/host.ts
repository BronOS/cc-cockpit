// The host side of the plugin: it runs in a Node process of its own, once per project window. A
// click counter, kept small on purpose: one panel, one setting, one command, storage and a badge.
//
// Only TYPES come from sdk/types.ts, so they vanish in the bundle and dist/host.js depends on
// nothing of the app's. `ctx` is already scoped to one project window.
import type { JsonValue, PluginContext } from '../sdk/types'

const PANEL = 'main'
const CLICKS_KEY = 'clicks'

export function activate(ctx: PluginContext): void {
  let clicks = 0
  let greeting = readGreeting(ctx)

  // The panel holds no state: every change posts the whole of it. A panel that is not shown drops
  // messages, which is why it says `ready` when it connects and gets the current state back.
  const publish = (): void => {
    ctx.panels.post(PANEL, { type: 'state', greeting, clicks })
  }
  const setClicks = async (value: number): Promise<void> => {
    clicks = value
    ctx.badge(PANEL, clicks > 0 ? clicks : null)
    publish()
    await ctx.storage.set(CLICKS_KEY, clicks)
  }

  // Storage is per project and survives restarts. Clicks wait for this read, or one made right
  // after a start would count from 0 and overwrite the saved value.
  const loaded = ctx.storage
    .get<number>(CLICKS_KEY)
    .then((saved) => setClicks(saved ?? 0))
    .catch((err: unknown) => ctx.log.error('could not read the saved count', err))

  ctx.panels.onMessage(PANEL, (message: JsonValue) => {
    const type = typeof message === 'object' && message !== null && !Array.isArray(message) ? message.type : undefined
    void loaded
      .then(() => {
        if (type === 'ready') publish()
        if (type === 'click') return setClicks(clicks + 1)
        if (type === 'reset') return setClicks(0)
        return undefined
      })
      .catch((err: unknown) => ctx.log.error('could not save the count', err))
  })

  // Settings arrive validated, with the manifest's defaults applied.
  ctx.onSettingsChange(() => {
    greeting = readGreeting(ctx)
    publish()
  })

  // Declared in plugin.json, which also gives it its title in the app.
  ctx.commands.register('say-hello', () => ctx.notify(`${greeting}! ${clicks} clicks so far.`))
}

function readGreeting(ctx: PluginContext): string {
  const value = ctx.settings.project.greeting
  return typeof value === 'string' ? value : 'Hello'
}
