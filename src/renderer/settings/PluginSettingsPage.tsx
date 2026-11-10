import { useEffect, useRef, useState } from 'react'
import type { PageHolder, SettingsPageInfo } from '../../shared/ipc'
import type { SettingsPageScope } from '../../shared/manifest'
import { ipcErrorMessage } from '../ipc-error'
import { HeldElsewhere } from '../plugins/HeldElsewhere'
import { requestSettingsPagePort } from '../plugins/panel-port-bus'
import { PluginFrame } from '../plugins/PluginFrame'
import { isOwnView } from '../shell-kind'

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
 * - Held by one view (design-web.md §5.4): when another view of the project (a browser, or the
 *   desktop seen from a browser) holds the page, this view shows "Open on <device> — Take over"
 *   instead of loading it; Take over loads it here, and its connect moves it (main ends the other
 *   view's page and tells every view, `settingsPage.held`). A view whose page was taken shows the
 *   same in its place; when the holder closes it, a view waiting here loads it again.
 */
export function PluginSettingsPage(props: { pluginId: string; pluginName: string; scope: SettingsPageScope }): React.JSX.Element | null {
  const { pluginId, pluginName, scope } = props
  const [info, setInfo] = useState<SettingsPageInfo | null | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [generation, setGeneration] = useState(0)
  /**
   * Another view that holds the page now (undefined: none, or this one): from `info.heldBy` when
   * this mounts, then from `settingsPage.held`. Take over clears it, and the page loads here.
   */
  const [elsewhere, setElsewhere] = useState<PageHolder | undefined>(undefined)

  // Subscribed before `info` is asked for, so a move between the two is not missed (the event is
  // newer than the answer either way: it wins below).
  const heard = useRef(false)
  useEffect(
    () =>
      window.cockpit.on('settingsPage.held', ({ pluginId: id, viewId, device }) => {
        if (id !== pluginId) return
        heard.current = true
        setElsewhere(viewId === null || device === null || isOwnView(viewId) ? undefined : { viewId, device })
      }),
    [pluginId]
  )

  useEffect(() => {
    let live = true
    heard.current = false
    window.cockpit.invoke('settingsPage.info', { pluginId, scope }).then(
      (answer) => {
        if (!live) return
        setInfo(answer)
        const held = answer?.enabled ? answer.heldBy : undefined
        if (!heard.current) setElsewhere(held && !isOwnView(held.viewId) ? held : undefined)
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
  if (elsewhere !== undefined) {
    return (
      <div className="settings-page-frame-wrap" data-settings-page={pluginId} data-settings-scope={scope}>
        <HeldElsewhere
          device={elsewhere.device}
          className="settings-page-held-elsewhere"
          // The frame mounts here (a fresh load) and its connect takes the page over. Not a new
          // generation: that asks `info` again, which still names the other view until the connect.
          onTakeOver={() => setElsewhere(undefined)}
        />
      </div>
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
