import { useEffect, useId, useRef, useState } from 'react'
import {
  WINDOW_OPACITY_RANGE,
  type BlurSupport,
  type SeeThroughArea,
  type WindowBackground
} from '../../shared/window-background'
import { ipcErrorMessage } from '../ipc-error'
import { isSeeThrough } from '../theme/see-through'
import type { Action } from './use-action'
import { Group, Row, Select, Switch } from './ui'

const linux = (): boolean => navigator.platform.toLowerCase().includes('linux')

/** What "Blur behind" says it does here; 'none' is why it is off. */
const BLUR_HELP: Record<BlurSupport, string> = {
  vibrancy:
    "macOS's frosted material: a tinted, nearly solid grey, so the desktop shows only as colour. Changes every transparent window at once.",
  acrylic: 'Blurs what is behind the window (acrylic, Windows 11 22H2 and later; no effect on older versions). Changes every transparent window at once.',
  none: 'Not available on Linux: Electron has no blur behind windows there.'
}

/** What reopening costs, said once and plainly: what comes back and what does not (restore.ts). */
const REOPEN_CONFIRM =
  'Reopen this window to apply? Claude conversations resume; shells start fresh, and anything running now is stopped.'

/**
 * Settings › Appearance and keys › Window: the see-through background of project windows
 * (shared/window-background.ts). The switch is creation-only (main reads it when it makes a project
 * window; Electron cannot make an open window transparent or opaque), so after a flip that leaves
 * this window looking otherwise, an in-page confirm offers to reopen it now (`window.reopen`: main
 * closes it and opens it again, its tabs restored as after a restart). Other open windows are not
 * touched: they pick the setting up whenever they are next opened. The opacity and the blur are
 * live in every window that was made transparent.
 *
 * The slider sends as it moves, not on release, so the windows follow the drag. It does not go
 * through `run` (which disables every control while one action is busy, and would end the drag);
 * instead one change is in flight at a time and the latest position is sent when it settles, so a
 * fast drag costs a handful of sends, not one per pixel.
 */
export function WindowBackgroundSettings(props: {
  value: WindowBackground
  blurSupport: BlurSupport
  busy: string | null
  run: Action['run']
  setError: Action['setError']
  reload: () => void
}): React.JSX.Element {
  const { value, blurSupport, busy, run, setError, reload } = props
  const id = useId()
  // The user flipped the switch on this page, and has not said "Later" to the reopen it offers
  // since. Offered only after a flip here: a setting changed in another window is that window's
  // offer (this one's help still says how it looks).
  const [offered, setOffered] = useState(false)
  // The slider's own position while it is being moved; main's value otherwise.
  const [opacity, setOpacity] = useState(value.opacity)
  const sending = useRef<{ inFlight: boolean; next: number | undefined }>({ inFlight: false, next: undefined })
  useEffect(() => {
    if (!sending.current.inFlight) setOpacity(value.opacity)
  }, [value.opacity])

  const set = (patch: Partial<WindowBackground>): void => {
    void run('windowBackground', () => window.cockpit.invoke('settings.windowBackgroundSet', { value: patch })).then(reload)
  }

  // Main closes this very window, so the reply usually never comes; a refusal shows as the page's
  // error like any other action's.
  const reopen = (): void => {
    void run('reopen', () => window.cockpit.invoke('window.reopen'))
  }

  const sendOpacity = (next: number): void => {
    const state = sending.current
    if (state.inFlight) {
      state.next = next
      return
    }
    state.inFlight = true
    window.cockpit
      .invoke('settings.windowBackgroundSet', { value: { opacity: next } })
      .catch((err: unknown) => setError(ipcErrorMessage(err)))
      .finally(() => {
        state.inFlight = false
        const pending = state.next
        state.next = undefined
        if (pending !== undefined && pending !== next) sendOpacity(pending)
        else reload()
      })
  }

  // This window was made before the switch last changed (or the switch was changed elsewhere).
  // The confirm shows only while that is so: flipping back to how the window was made hides it,
  // with nothing to reopen for.
  const here = isSeeThrough()
  const differs = here !== value.transparent
  const confirm = offered && differs
  // Without the confirm (declined, or the change came from another window) the help says so, or
  // "nothing happened" is the only thing the user sees.
  const thisWindow =
    !differs || confirm
      ? ''
      : here
        ? ' This window stays transparent until it is reopened.'
        : ' This window stays opaque until it is reopened.'

  return (
    <Group
      title="Window"
      description="Lets the desktop show through the backgrounds of project windows: the top bar, tabs, terminal and side zones. Text, menus, dialogs, overlays and this screen stay solid."
    >
      <div className="settings-card">
        <Row
          label="Transparent background"
          htmlFor={`${id}-transparent`}
          help={
            <>
              A window is made see-through or solid when it opens. After a change this window offers to reopen; other
              open windows keep how they were made until they are next opened.{thisWindow}
              {linux() && ' Needs a compositing window manager.'}
            </>
          }
        >
          <Switch
            id={`${id}-transparent`}
            checked={value.transparent}
            disabled={busy !== null}
            onChange={(e) => {
              setOffered(true)
              set({ transparent: e.target.checked })
            }}
          />
        </Row>
        {confirm && (
          <div className="settings-reopen" role="group" aria-label="Reopen window">
            <span className="settings-confirm">{REOPEN_CONFIRM}</span>
            <span className="settings-item-actions">
              <button type="button" disabled={busy !== null} onClick={reopen}>
                Reopen window
              </button>
              <button type="button" className="quiet" onClick={() => setOffered(false)}>
                Later
              </button>
            </span>
          </div>
        )}
        <Row
          label="See-through"
          htmlFor={`${id}-area`}
          help="Main area only keeps the side and bottom panels solid; the top bar, tabs and terminal stay see-through. Changes every transparent window at once."
        >
          <Select
            id={`${id}-area`}
            aria-label="See-through"
            value={value.area}
            disabled={busy !== null || !value.transparent}
            onChange={(e) => set({ area: e.target.value as SeeThroughArea })}
          >
            <option value="window">Whole window</option>
            <option value="main">Main area only</option>
          </Select>
        </Row>
        <Row
          label="Background opacity"
          htmlFor={`${id}-opacity`}
          help="How much of the theme's background stays. Changes every transparent window at once."
        >
          <span className="settings-range">
            <input
              id={`${id}-opacity`}
              type="range"
              min={WINDOW_OPACITY_RANGE.min}
              max={WINDOW_OPACITY_RANGE.max}
              step={1}
              value={opacity}
              disabled={!value.transparent}
              onChange={(e) => {
                const next = Number(e.target.value)
                setOpacity(next)
                sendOpacity(next)
              }}
            />
            <output htmlFor={`${id}-opacity`} className="settings-range-value">
              {opacity} %
            </output>
          </span>
        </Row>
        <Row label="Blur behind" htmlFor={`${id}-blur`} help={BLUR_HELP[blurSupport]}>
          <Switch
            id={`${id}-blur`}
            checked={blurSupport !== 'none' && value.blur}
            disabled={busy !== null || blurSupport === 'none' || !value.transparent}
            onChange={(e) => set({ blur: e.target.checked })}
          />
        </Row>
      </div>
    </Group>
  )
}
