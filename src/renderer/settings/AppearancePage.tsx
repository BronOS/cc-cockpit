import { useId } from 'react'
import type { AppearanceView } from '../../shared/ipc'
import type { TabCloseSide } from '../../shared/types'
import { TerminalFontSettings } from './TerminalFontSettings'
import { WindowBackgroundSettings } from './WindowBackgroundSettings'
import { Group, PageHeader, Row, Select } from './ui'
import { useAction } from './use-action'
import { useLoaded } from './use-loaded'

const loadAppearance = (): Promise<AppearanceView> => window.cockpit.invoke('settings.appearance')

/**
 * Settings › Appearance (design-next §5.1): how every window looks, app-wide. The theme, the
 * see-through window background (WindowBackgroundSettings), which end of a tab its close button sits
 * at, and the terminals' font (TerminalFontSettings). A theme change goes through main, which tells
 * every window (and so every plugin panel and terminal). How the app behaves is General; the keys
 * are Keybindings.
 */
export function AppearancePage(): React.JSX.Element {
  const { data, error: loadError, reload } = useLoaded(loadAppearance)
  const { busy, error, run, setError } = useAction()
  const id = useId()

  return (
    <section aria-label="Appearance">
      <PageHeader title="Appearance" description="App-wide: the theme, the window background, the tabs and the terminal font of every window." />
      {(error ?? loadError) && <p role="alert" className="settings-alert">{error ?? loadError}</p>}
      {data && (
        <>
          <Group title="Theme">
            <div className="settings-card">
              <Row
                label="Theme"
                htmlFor={`${id}-theme`}
                help={`Showing ${data.themes.find((t) => t.id === data.current)?.name ?? data.current}.`}
              >
                <Select
                  id={`${id}-theme`}
                  aria-label="Theme"
                  value={data.selected ?? ''}
                  disabled={busy !== null}
                  onChange={(e) => {
                    const id = e.target.value === '' ? null : e.target.value
                    void run('theme', () => window.cockpit.invoke('settings.themeSet', { id })).then(reload)
                  }}
                >
                  <option value="">Follow the system</option>
                  {/* A pick whose theme is gone (plugin uninstalled; main keeps the id): without its own
                      option the browser shows "Follow the system", and choosing that fires no change. */}
                  {data.selected !== null && !data.themes.some((t) => t.id === data.selected) && (
                    <option value={data.selected}>{data.selected} (not installed)</option>
                  )}
                  {data.themes.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} ({t.kind})
                    </option>
                  ))}
                </Select>
              </Row>
            </div>
          </Group>

          <WindowBackgroundSettings
            value={data.windowBackground}
            blurSupport={data.blurSupport}
            busy={busy}
            run={run}
            setError={setError}
            reload={reload}
          />

          <Group title="Tabs">
            <div className="settings-card">
              <Row
                label="Close button position"
                htmlFor={`${id}-close-side`}
                help="Which end of each tab the × sits at, in every window."
              >
                <Select
                  id={`${id}-close-side`}
                  aria-label="Close button position"
                  value={data.tabCloseSide}
                  disabled={busy !== null}
                  onChange={(e) => {
                    const value = e.target.value as TabCloseSide
                    void run('tabCloseSide', () => window.cockpit.invoke('settings.tabCloseSideSet', { value })).then(reload)
                  }}
                >
                  <option value="left">Left</option>
                  <option value="right">Right</option>
                </Select>
              </Row>
            </div>
          </Group>

          <TerminalFontSettings font={data.terminalFont} busy={busy} run={run} reload={reload} />
        </>
      )}
    </section>
  )
}
