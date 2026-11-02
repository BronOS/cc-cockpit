import { useEffect, useId, useRef, useState, type CSSProperties } from 'react'
import {
  isPaletteColor,
  PROJECT_COLOR_LABEL,
  PROJECT_PALETTE,
  projectColorCss,
  type ProjectColor
} from '../../shared/project-color'
import { ipcErrorMessage } from '../ipc-error'
import type { Action } from './use-action'
import { Group, Row } from './ui'

/** What the custom swatch's colour field opens on while the project has no custom colour. */
const CUSTOM_START = '#7f7f7f'

/**
 * Settings › This project › Colour (shared/project-color.ts): None, the eight palette colours and
 * Custom… (the platform's colour panel through a native `<input type="color">`). None and the
 * palette are native radio buttons drawn as swatches, in a radio group: arrow keys move between
 * them, Space picks, and each is named "Colour: Blue" for screen readers and the specs. The custom
 * swatch sits after the group; while the project has a custom colour it shows that colour with the
 * picked ring and names it, and no radio is checked.
 *
 * Main checks every value (palette name or `#rrggbb`) and stores it on this window's own project;
 * the window's bar and every other window's strip follow from main's pushes, not from this page.
 * The colour field sends as it moves (the macOS panel fires an input per drag step), one change in
 * flight at a time with the latest sent when it settles, like the opacity slider; it does not go
 * through `run`, which would disable the swatches mid-drag.
 */
export function ProjectColorSettings(props: {
  value: ProjectColor | undefined
  busy: string | null
  run: Action['run']
  setError: Action['setError']
  reload: () => void
}): React.JSX.Element {
  const { busy, run, setError, reload } = props
  const id = useId()
  // The pick shown at once, before main's answer and the page's reload: the radios are controlled,
  // and without this the click would snap back to the old swatch until the reload lands. It holds
  // only while main's value is still the one it was picked over: the reload's new value replaces
  // it, and a refusal drops it (the stored one shows again with the error).
  const [pending, setPending] = useState<{ over: ProjectColor | undefined; to: ProjectColor | undefined } | null>(null)
  const value = pending !== null && pending.over === props.value ? pending.to : props.value
  const custom = value !== undefined && !isPaletteColor(value) ? value : undefined
  // The colour field's own value while it is being moved; main's custom colour otherwise.
  const [draft, setDraft] = useState<string>(custom ?? CUSTOM_START)
  const sending = useRef<{ inFlight: boolean; next: string | undefined }>({ inFlight: false, next: undefined })
  useEffect(() => {
    if (!sending.current.inFlight && custom !== undefined) setDraft(custom)
  }, [custom])

  const pick = (next: ProjectColor | null): void => {
    setPending({ over: props.value, to: next ?? undefined })
    void run('projectColor', () => window.cockpit.invoke('settings.projectColorSet', { value: next })).then((stored) => {
      // undefined: refused (or another action was busy); null: None was stored.
      if (stored === undefined) setPending(null)
      reload()
    })
  }

  const sendCustom = (next: string): void => {
    const state = sending.current
    if (state.inFlight) {
      state.next = next
      return
    }
    state.inFlight = true
    window.cockpit
      .invoke('settings.projectColorSet', { value: next as ProjectColor })
      .catch((err: unknown) => setError(ipcErrorMessage(err)))
      .finally(() => {
        state.inFlight = false
        const pending = state.next
        state.next = undefined
        if (pending !== undefined && pending !== next) sendCustom(pending)
        else reload()
      })
  }

  const disabled = busy !== null
  const radio = (color: ProjectColor | null, label: string): React.JSX.Element => (
    <input
      key={color ?? 'none'}
      type="radio"
      name={`${id}-color`}
      className={color === null ? 'project-swatch none' : 'project-swatch'}
      aria-label={`Colour: ${label}`}
      title={label}
      checked={color === null ? value === undefined : value === color}
      disabled={disabled}
      style={color === null ? undefined : ({ '--swatch': projectColorCss(color) } as CSSProperties)}
      onChange={() => pick(color)}
    />
  )

  return (
    <Group title="Appearance" description="How this project's window stands out from the others.">
      <div className="settings-card">
        <Row
          label="Colour"
          help="A line along the window's top edge, a tint of its top bar, and a dot by the project's name here, in other windows' top bars and in the project picker. Palette colours follow the theme; a custom one is the same in every theme."
          data-testid="project-color"
        >
          <div className="project-swatches">
            <div role="radiogroup" aria-label="Project colour" className="project-swatch-group">
              {radio(null, 'None')}
              {PROJECT_PALETTE.map((color) => radio(color, PROJECT_COLOR_LABEL[color]))}
            </div>
            <span
              className={`project-swatch-custom${custom ? ' checked' : ''}`}
              style={custom ? ({ '--swatch': draft } as CSSProperties) : undefined}
              title={custom ? `Custom ${custom}` : 'Custom…'}
            >
              <input
                type="color"
                aria-label={custom ? `Colour: Custom ${custom}` : 'Colour: Custom…'}
                value={draft}
                disabled={disabled}
                onChange={(e) => {
                  const next = e.target.value.toLowerCase()
                  setDraft(next)
                  sendCustom(next)
                }}
              />
            </span>
          </div>
        </Row>
      </div>
    </Group>
  )
}
