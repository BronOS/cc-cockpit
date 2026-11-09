// Plugin host entry: runs inside an Electron utilityProcess, one per project window
// (src/main/plugins/host-process.ts spawns it, host-manager.ts drives it).
//
// It is plain Node with one extra: `process.parentPort`, the channel to main. It imports nothing
// from `electron`, so plugins get no Electron main APIs through it; the plugins are trusted code
// the user installed, but everything app-level they do goes through `ctx` and main's checks.
//
// Methods main may call (src/host/rpc.ts):
//   activate   { plugins: HostPluginSpec[], serviceProviders? } -> PluginRunState[]  load and activate them
//   deactivate {}                           -> null               every plugin's deactivate()
//   command.run { pluginId, id }             -> null               run a command the plugin registered
//   plugin.reload { plugin: HostPluginSpec } -> PluginRunState     deactivate, forget its modules,
//                                                                  activate again (linked dev plugin)
//   plugin.unload { pluginId }              -> null               deactivate one plugin, keep the rest
//   cli.run    { pluginId, name, argv, stdin, cwd, tabId?, callId } -> { stdout, stderr, code }
//                                                                  run a ctx.cli.register handler (`ccc <name>`)
//   files.open { pluginId, path, tabId? }   -> boolean            a Sessions panel file click (or a
//                                                                  ctx.files.open main routed here) for
//                                                                  ctx.files.onOpen (true: taken)
//   overlay.buttons { key, info }           -> button[]           the type buttons for a typed overlay
//                                                                  (ctx.overlay.buttons, host/overlay-buttons.ts)
//   overlay.buttonClick { source, ... }     -> { close } | null   a toolbar click: the opener's onButton
//                                                                  or a type button's run
//   overlay.discuss { pluginId, handle }    -> { text } | null    Discuss with Claude: the handle's onDiscuss
// Events from main:
//   settings   { pluginId, project, app }     new validated settings (ctx.onSettingsChange)
//   sessions   { sessions: SessionInfo[] }    this project's Claude tabs changed (ctx.sessions.onChange)
//   sessions.rateLimits { rateLimits }        the account's plan usage changed (ctx.sessions.onRateLimits)
//   cli.cancel { callId }                     main gave up on a cli.run (Ctrl+C, timeout): abort its signal
//   overlay.message { pluginId, handle, message }  an html overlay's page posted (ctx.overlay.start)
//   panel.action { pluginId, panelId, actionId }   a click on a panel header action (ctx.panels.onAction)
//   slot.close { pluginId, id }               a slot frame this host provides ended (SlotInstance.onClose)
//   settingsPage.close { pluginId, id }       the plugin's settings page ended (SettingsPageInstance.onClose)
//   overlay.ended { key }                     a typed overlay went: its type buttons' runs go
// Requests to main (checked there against this host's own project and plugins):
//   commands.register / commands.unregister { pluginId, id }, notify { pluginId, text, options? } -> { clicked }
//   sessions.list {}, sessions.rateLimits { pluginId } -> RateLimits | null, sessions.send { pluginId, tabId, text }, sessions.open { pluginId, cwd?, prompt? },
//   sessions.openShell { pluginId, cwd?, focus? } -> { tabId } (a plain shell tab; main checks the cwd and budget),
//   sessions.openCommand { pluginId, argv, cwd?, title?, focus? } -> { tabId } (argv with no shell, marked with the plugin),
//   slots.available { pluginId, type } -> boolean (ctx.slots.available), panels.slots { pluginId, panelId, placements },
//   badge { pluginId, panelId, value }, panels.header { pluginId, panelId, header }, overlay.open { pluginId, spec, handle } (no timeout; see
//   src/main/plugins/host-api.ts), overlay.post { pluginId, handle, message }, overlay.close { pluginId, handle },
//   overlay.setButtons { pluginId, handle, buttons } (the opener's buttons, checked again in main),
//   overlay.discussable { pluginId, handle, on } (the handle has an onDiscuss handler: Discuss shows),
//   files.open { pluginId, path, tabId? } -> { via } (ctx.files.open; main routes it like a click),
//   openExternal { pluginId, url } -> null (ctx.openExternal; main checks the URL and opens the browser)
// Events to main:
//   log        { pluginId, level, text }      a ctx.log line
//   status     { pluginId, error: string|null }  a scheduled job started or stopped failing (the ⚠)
// Next to the RPC, main hands over panel ports (src/main/plugins/panel-ports.ts): a message
// `{ "panelPort": { pluginId, panelId } }` with the port in its transfer list. Those never reach the
// RPC endpoint; they are attached to the plugin's ctx.panels (host/ctx/ui.ts). A slot frame the
// plugin provides arrives the same way as `{ "slotOpen": { pluginId, id, type, host, params? } }`
// and ends with the `slot.close { pluginId, id }` event or its port closing (host/ctx/slots.ts).
// A plugin's settings page likewise: `{ "settingsPageOpen": { pluginId, id, scope } }`, ended by
// `settingsPage.close { pluginId, id }` or its port closing (host/ctx/settings-page.ts).
import { HostContexts, type LogLevel } from './ctx'
import { settingsPageOpenTag } from './ctx/settings-page'
import { slotOpenTag } from './ctx/slots'
import { fromMainPort, panelPortTag, type MainPortLike, type PanelPort } from './ctx/ui'
import { parsePluginSpecs, parseServiceProviders, PluginLoader } from './loader'
import { RpcEndpoint, type RpcPort } from './rpc'
import { installShutdownHandlers } from './shutdown'

/** A message on the parent port; `ports` holds a transferred panel port. */
interface ParentMessage {
  data: unknown
  ports?: MainPortLike[]
}

/** The slice of Electron's ParentPort used here (typed locally: no `electron` import at all). */
interface ParentPort {
  on(event: 'message', listener: (e: ParentMessage) => void): void
  off(event: 'message', listener: (e: ParentMessage) => void): void
  postMessage(message: unknown): void
}

function start(): void {
  const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort
  if (!parentPort) {
    console.error('plugin host: no parent port (not started as a utilityProcess)')
    process.exit(1)
  }
  /** A panel's port from main: attached to the plugin's panel, or closed when it is not one. */
  const receivePort = (e: ParentMessage): void => {
    const [raw, ...extra] = e.ports ?? []
    for (const p of extra) p.close()
    if (!raw) return
    const slotTag = slotOpenTag(e.data)
    if (slotTag) {
      // A slot frame (this plugin provides the page in it); the close of THIS port ends THIS frame.
      const slotPort: PanelPort = fromMainPort(raw, () => contexts.detachSlotPort(slotTag.pluginId, slotTag.id, slotPort))
      contexts.attachSlotPort(slotTag, slotPort)
      return
    }
    const pageTag = settingsPageOpenTag(e.data)
    if (pageTag) {
      // The plugin's settings page; the close of THIS port ends THIS page, never a newer one.
      const pagePort: PanelPort = fromMainPort(raw, () => contexts.detachSettingsPagePort(pageTag.pluginId, pageTag.id, pagePort))
      contexts.attachSettingsPagePort(pageTag, pagePort)
      return
    }
    const tag = panelPortTag(e.data)
    if (!tag) {
      raw.close()
      return
    }
    // The detach on close is tied to THIS port: the close of a reloaded page's old port can come
    // after the new port is attached, and must not take the new one down.
    const panelPort: PanelPort = fromMainPort(raw, () => contexts.detachPanelPort(tag.pluginId, tag.panelId, panelPort))
    contexts.attachPanelPort(tag.pluginId, tag.panelId, panelPort)
  }
  const port: RpcPort = {
    postMessage: (message) => parentPort.postMessage(message),
    onMessage: (listener) => {
      const l = (e: ParentMessage): void => {
        // Port messages are main's own; they are not RPC and the endpoint would drop them.
        if (e.ports && e.ports.length > 0) receivePort(e)
        else listener(e.data)
      }
      parentPort.on('message', l)
      return () => parentPort.off('message', l)
    }
  }
  // The loader's own messages ("plugin x: activate() failed") go to main's console via stderr.
  const contexts = new HostContexts({
    log: (pluginId: string, level: LogLevel, text: string) => rpc.emit('log', { pluginId, level, text }),
    call: (method, params, options) => rpc.call(method, params, options),
    emit: (event, params) => rpc.emit(event, params),
    env: process.env,
    services: () => loader.services
  })
  const loader: PluginLoader = new PluginLoader({
    makeContext: (spec) => contexts.create(spec),
    // Dropped emits and throwing event listeners land in the plugin's own log.
    pluginLog: (pluginId, text) => rpc.emit('log', { pluginId, level: 'warn', text }),
    // A failed activate or a finished deactivate: schedules, children and storage are let go.
    release: (spec) => contexts.dispose(spec.id)
  })
  const rpc: RpcEndpoint = new RpcEndpoint({
    port,
    handlers: {
      activate: (params) => {
        const specs = parsePluginSpecs(params)
        // The project's provider picks come with every activate (main recomputes them on restart).
        loader.services.setChoices(parseServiceProviders(params))
        return loader.activateAll(specs)
      },
      deactivate: async () => {
        // First, before any plugin code: main kills the host 5 s after asking, while the loader
        // may wait up to 10 s for a pending activate and 5 s more for its deactivate(), and
        // contexts.dispose (which also does this) runs only after those. A deactivate() that
        // hangs synchronously would also keep the SIGTERM handler below from ever running.
        contexts.killChildrenAndFlush()
        await loader.deactivateAll()
        // Plugins that were still activating are released by their own deactivate; this catches
        // any context left over.
        contexts.disposeAll()
        return null
      },
      'command.run': (params) => contexts.runCommand(params),
      'cli.run': (params) => contexts.runCli(params),
      'files.open': (params) => contexts.openFile(params),
      'overlay.buttons': (params) => contexts.overlayButtons(params),
      'overlay.buttonClick': (params) => contexts.overlayButtonClick(params),
      'overlay.discuss': (params) => contexts.overlayDiscuss(params),
      'plugin.reload': (params) => {
        const [spec] = parsePluginSpecs({ plugins: [(params as { plugin?: unknown } | null)?.plugin] })
        if (!spec) throw new Error('plugin.reload: no plugin')
        return loader.reload(spec)
      },
      'plugin.unload': async (params) => {
        const pluginId = (params as { pluginId?: unknown } | null)?.pluginId
        if (typeof pluginId !== 'string') throw new Error('plugin.unload: pluginId must be a string')
        await loader.unload(pluginId)
        return null
      }
    },
    onEvent: (event, params) => contexts.handleEvent(event, params)
  })
  // A forgotten `await` in one plugin must not take every plugin of the window down with it (Node
  // exits on an unhandled rejection by default). An uncaught synchronous exception still crashes
  // the host: its state is unknown, and main restarts it with backoff.
  process.on('unhandledRejection', (reason) => {
    console.error('plugin host: unhandled rejection', reason)
  })
  // App quit and a deactivate past its grace kill the host without a finished deactivate, and a
  // crash exits on its own: the plugins' detached children and pending storage writes must not
  // be left behind either way (src/host/shutdown.ts).
  installShutdownHandlers(process, () => contexts.killChildrenAndFlush())
}

start()
