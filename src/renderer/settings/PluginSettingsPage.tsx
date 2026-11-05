import { useEffect, useState } from 'react'
import type { SettingsPageInfo } from '../../shared/ipc'
import type { SettingsPageScope } from '../../shared/manifest'
import { ipcErrorMessage } from '../ipc-error'
import { requestSettingsPagePort } from '../plugins/panel-port-bus'
import { PluginFrame } from '../plugins/PluginFrame'

/**
 * A plugin's html settings page (design-next §5.4), under its schema form: the page from
 * `contributes.settings.page` in a sandboxed iframe (PluginFrame, the panel loader: `cc-plugin://`,
 * the panel CSP, the SDK with theme and components), with its own port to the plugin's backend in
 * THIS window's host (`settingsPage.connect`, `ctx.settingsPage.onOpen` on the other end).
 *
 * - The plugin does not run in this project (not enabled): there is no backend to talk to, so the
 *   page is not loaded and a line says how to get one; the schema form above still works.
 * - The host (re)started or the plugin reloaded (`panels.reload`): the page is mounted again and
 *   connects to the new copy, as a panel does.
 * - Unmounting (Settings closed, another page, the row folded) tells main; the backend hears onClose.
 *   Settings shows one page per plugin at a time, and main closes an older one when a new one connects.
 */
export function PluginSettingsPage(props: { pluginId: string; pluginName: string; scope: SettingsPageScope }): React.JSX.Element | null {
  const { pluginId, pluginName, scope } = props
  const [info, setInfo] = useState<SettingsPageInfo | null | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [generation, setGeneration] = useState(0)

  useEffect(() => {
    let live = true
    window.cockpit.invoke('settingsPage.info', { pluginId, scope }).then(
      (answer) => {
        if (live) setInfo(answer)
      },
      (err: unknown) => {
        if (live) setError(ipcErrorMessage(err))
      }
    )
    return () => {
      live = false
    }
  }, [pluginId, scope, generation])

  useEffect(
    () =>
      window.cockpit.on('panels.reload', ({ pluginIds }) => {
        if (pluginIds.includes(pluginId)) setGeneration((g) => g + 1)
      }),
    [pluginId]
  )

  useEffect(
    () => () => {
      window.cockpit
        .invoke('settingsPage.disconnect', { pluginId })
        .catch((err: unknown) => console.warn(`settingsPage.disconnect ${pluginId} failed`, err))
    },
    [pluginId]
  )

  if (error !== null) return <div className="settings-error">{error}</div>
  // Not loaded yet, or the plugin declares no page for this scope (an older view).
  if (!info) return null
  if (!info.enabled) {
    return (
      <p className="settings-item-meta settings-page-note" data-testid="settings-page-not-enabled">
        Enable {pluginName} in this project to edit this page.
      </p>
    )
  }
  return (
    <div className="settings-page-frame-wrap" data-settings-page={pluginId} data-settings-scope={scope}>
      <PluginFrame
        key={generation}
        src={info.src}
        title={`${pluginName} settings`}
        className="settings-page-frame"
        connect={(deliver) => requestSettingsPagePort(pluginId, scope, deliver)}
      />
    </div>
  )
}
