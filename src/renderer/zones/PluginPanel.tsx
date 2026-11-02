import { useEffect, useState } from 'react'
import { PLUGIN_STOPPED_TEXT, type PanelInfo } from '../../shared/ipc'
import { requestPanelPort } from '../plugins/panel-port-bus'
import { PluginFrame } from '../plugins/PluginFrame'
import { WebviewPanel } from './WebviewPanel'

/** `<pluginId>/<panelId>` -> the plugin id (plugin ids hold no slash, so the last one splits). */
function pluginOf(panelKey: string): string {
  return panelKey.slice(0, panelKey.lastIndexOf('/'))
}

/**
 * A plugin's panel (design §5 › Panel side): its page in a sandboxed iframe (PluginFrame), with a
 * MessagePort to its plugin's host that main hands out on every load (panel-port-bus.ts).
 *
 * - The plugin's host gave up after repeated crashes: the page is replaced by "plugin stopped" and
 *   a Restart button (the host starts again with a fresh crash budget).
 * - The plugin errored (failed to activate, a scheduled job failing, the host restarting): a ⚠ line
 *   with the reason above the page, which stays usable.
 * - The host (re)started: the page reloads (`panels.reload`) and connects to the new host, since
 *   the port of the old one is dead and the page asks for what it shows when it connects.
 * - A `"kind": "webview"` panel has no page of ours: its toolbar and placeholder (WebviewPanel),
 *   mounted again on a host (re)start so it reports its placement to the plugin's new views.
 */
export function PluginPanel(props: { info: PanelInfo }): React.JSX.Element {
  const { panelKey, src, error, title } = props.info
  const [generation, setGeneration] = useState(0)
  const [restarting, setRestarting] = useState(false)
  const stopped = error === PLUGIN_STOPPED_TEXT

  useEffect(() => {
    const pluginId = pluginOf(panelKey)
    return window.cockpit.on('panels.reload', ({ pluginIds }) => {
      if (pluginIds.includes(pluginId)) setGeneration((g) => g + 1)
    })
  }, [panelKey])

  if (stopped) {
    const restart = (): void => {
      setRestarting(true)
      window.cockpit
        .invoke('plugins.restart')
        .catch((err: unknown) => console.warn('plugin restart failed', err))
        .finally(() => setRestarting(false))
    }
    return (
      <div className="panel-body plugin-stopped" data-panel-body={panelKey} role="status">
        <span>plugin stopped:</span>
        <button type="button" onClick={restart} disabled={restarting}>
          Restart
        </button>
      </div>
    )
  }

  // Remounted on `panels.reload` too: the plugin's views went with its old copy (and main dropped
  // their placements), so the new copy's view would get no report until the placeholder moved or
  // its visibility changed (review finding: invisible after a dev reload). A fresh mount reports
  // where the placeholder is at once.
  if (props.info.kind === 'webview') return <WebviewPanel key={generation} info={props.info} />

  return (
    <div className="panel-body plugin-panel" data-panel-body={panelKey}>
      {error && (
        <p className="plugin-panel-error" role="status" title={error}>
          ⚠ {error}
        </p>
      )}
      {src ? (
        <PluginFrame
          key={generation}
          src={src}
          title={title}
          className="plugin-frame"
          connect={(deliver) => requestPanelPort(panelKey, deliver)}
        />
      ) : (
        <p className="panel-placeholder">{title} has no page</p>
      )}
    </div>
  )
}
