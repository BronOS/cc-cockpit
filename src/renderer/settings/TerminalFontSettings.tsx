import { useEffect, useId, useRef, useState } from 'react'
import {
  DEFAULT_TERMINAL_FONT,
  TERMINAL_FONT_RANGES,
  TERMINAL_FONT_WEIGHTS,
  type TerminalFont,
  type TerminalFontWeight
} from '../../shared/terminal-font'
import type { Action } from './use-action'
import { isCustomValue } from './font-picker-model'
import { TerminalFontPicker } from './TerminalFontPicker'
import { Group, Row, Select } from './ui'

/**
 * Nerd Font glyphs for the preview: a powerline arrow (U+E0B0), the git logo (U+F113) and a folder
 * icon (U+E5FF). A font without them shows boxes or blanks, which is the point: a zsh theme's
 * icons look the same in the terminal.
 */
const ICONS = '  '

/**
 * Settings › Appearance and keys › Terminal: the font every terminal draws with (tabs and terminal
 * overlays), apart from the app UI's own. Main checks every value; each change goes to every open
 * terminal at once (`prefs.changed`). Text and number fields send on Enter or when they lose focus,
 * not per keystroke: "1" on the way to "16" is not a size, and each send refits every terminal.
 * The family is a dropdown (TerminalFontPicker: bundled, installed, Custom…); whatever it picks is
 * stored as the same CSS font list the Custom… field edits.
 */
export function TerminalFontSettings(props: {
  font: TerminalFont
  busy: string | null
  run: Action['run']
  reload: () => void
}): React.JSX.Element {
  const { font, busy, run, reload } = props
  // Custom… was picked: its field shows whatever the family is. A family that is none of the
  // dropdown's picks (typed before, or by hand in app.json) shows it without the pick.
  const [custom, setCustom] = useState(false)
  const showCustom = custom || isCustomValue(font.family)
  const customInput = useRef<HTMLInputElement>(null)
  // Bumped by each Custom… pick: the keyboard then goes to the field, after the render that draws
  // it (it may not have existed when picked).
  const [customFocus, setCustomFocus] = useState(0)
  const id = useId()

  useEffect(() => {
    if (customFocus > 0) customInput.current?.focus()
  }, [customFocus])

  const set = (value: Partial<TerminalFont> | null): void => {
    void run('terminalFont', () => window.cockpit.invoke('settings.terminalFontSet', { value })).then(reload)
  }

  const isDefault = (Object.keys(DEFAULT_TERMINAL_FONT) as Array<keyof TerminalFont>).every(
    (k) => font[k] === DEFAULT_TERMINAL_FONT[k]
  )

  return (
    <Group
      title="Terminal"
      description="The font of every terminal, tabs and terminal overlays alike; the app's own text is not affected."
      actions={
        <button
          type="button"
          disabled={busy !== null || isDefault}
          onClick={(e) => {
            // The button stays disabled after a reset (nothing left to reset), and a disabled
            // button gets no keys: with the focus left on it, Esc would no longer close Settings.
            e.currentTarget.closest<HTMLElement>('[role="dialog"]')?.focus()
            setCustom(false)
            set(null)
          }}
        >
          Reset to defaults
        </button>
      }
    >
      <div className="settings-card">
        <Row
          label="Font family"
          htmlFor={`${id}-family`}
          help="JetBrains Mono and MesloLGS NF come with the app, Nerd Font icons included (a zsh or starship theme's); Installed lists the monospaced fonts on this computer."
        >
          <TerminalFontPicker
            id={`${id}-family`}
            value={font.family}
            disabled={busy !== null}
            onPick={(family) => {
              if (family === null) {
                setCustom(true)
                setCustomFocus((n) => n + 1)
                return
              }
              setCustom(false)
              if (family !== font.family) set({ family })
            }}
          />
        </Row>
        {showCustom && (
          <Row
            label="Custom font list"
            htmlFor={`${id}-custom`}
            help={
              <>
                A CSS font list, e.g. <code>&quot;Iosevka Term&quot;, monospace</code> (quote a name that has digits or
                symbols). For a zsh or starship theme's icons, name a patched Nerd Font.
              </>
            }
          >
            <DraftInput
              id={`${id}-custom`}
              inputRef={customInput}
              className="settings-font-family mono"
              ariaLabel="Custom terminal font family"
              type="text"
              value={font.family}
              disabled={busy !== null}
              onCommit={(text) => {
                if (text.trim() === font.family) return false
                set({ family: text })
                return true
              }}
            />
          </Row>
        )}
        <NumberField
          label="Size"
          unit="px"
          ariaLabel="Terminal font size"
          range={TERMINAL_FONT_RANGES.size}
          step={1}
          value={font.size}
          disabled={busy !== null}
          onCommit={(size) => set({ size })}
        />
        <NumberField
          label="Line height"
          ariaLabel="Terminal line height"
          range={TERMINAL_FONT_RANGES.lineHeight}
          step={0.05}
          value={font.lineHeight}
          disabled={busy !== null}
          onCommit={(lineHeight) => set({ lineHeight })}
        />
        <NumberField
          label="Letter spacing"
          unit="px"
          ariaLabel="Terminal letter spacing"
          range={TERMINAL_FONT_RANGES.letterSpacing}
          step={0.5}
          value={font.letterSpacing}
          disabled={busy !== null}
          onCommit={(letterSpacing) => set({ letterSpacing })}
        />
        <WeightSelect label="Weight" value={font.weight} disabled={busy !== null} onChange={(weight) => set({ weight })} />
        <WeightSelect
          label="Bold weight"
          value={font.boldWeight}
          disabled={busy !== null}
          onChange={(boldWeight) => set({ boldWeight })}
        />
        <div className="settings-row settings-preview-row">
          <div
            className="terminal-font-preview"
            data-testid="terminal-font-preview"
            style={{
              fontFamily: font.family,
              fontSize: `${font.size}px`,
              lineHeight: font.lineHeight,
              letterSpacing: `${font.letterSpacing}px`
            }}
          >
            <div style={{ fontWeight: font.weight }}>
              ~/project main {ICONS} $ ls -la 0O 1lI {'{}'} =&gt; !=
            </div>
            <div style={{ fontWeight: font.boldWeight }}>bold: error[E0308] {ICONS}</div>
          </div>
        </div>
      </div>
    </Group>
  )
}

/**
 * A field that keeps what is typed until Enter or blur, then hands it to `onCommit`; a new `value`
 * from main (after a save, a reset or another window's change) replaces the draft, and so does
 * the value in effect when `onCommit` turns the text down (returns false).
 */
function DraftInput(props: {
  id?: string
  className?: string
  ariaLabel: string
  type: 'text' | 'number'
  value: string
  disabled: boolean
  onCommit: (text: string) => boolean
  inputRef?: React.Ref<HTMLInputElement>
  min?: number
  max?: number
  step?: number
}): React.JSX.Element {
  // Destructured whole: the hooks lint treats every `props.x` as a ref read once props carry a ref.
  const { id, className, ariaLabel, type, value, disabled, onCommit, inputRef, min, max, step } = props
  const [draft, setDraft] = useState(value)
  // A new value from main replaces the draft during the render that brings it (React's pattern for
  // state derived from a prop), not in an effect, which would draw the stale draft first.
  const [shown, setShown] = useState(value)
  if (shown !== value) {
    setShown(value)
    setDraft(value)
  }
  const commit = (): void => {
    if (draft !== value && !onCommit(draft)) setDraft(value)
  }
  return (
    <input
      ref={inputRef}
      id={id}
      className={className}
      type={type}
      aria-label={ariaLabel}
      min={min}
      max={max}
      step={step}
      value={draft}
      disabled={disabled}
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
      }}
    />
  )
}

export function NumberField(props: {
  label: string
  /** The line under the label, as on any settings row. */
  help?: string
  /** Shown after the field (px); the value sent is the bare number. */
  unit?: string
  ariaLabel: string
  range: { min: number; max: number }
  step: number
  value: number
  disabled: boolean
  onCommit: (n: number) => void
}): React.JSX.Element {
  const { range } = props
  const id = useId()
  return (
    <Row label={props.label} htmlFor={id} help={props.help}>
      <span className="settings-number">
        <DraftInput
          id={id}
          ariaLabel={props.ariaLabel}
          type="number"
          min={range.min}
          max={range.max}
          step={props.step}
          value={String(props.value)}
          disabled={props.disabled}
          onCommit={(text) => {
            // An emptied or half-typed field is not a change: it goes back to the value in effect.
            // Main refuses an out-of-range number and says why; the field keeps it to be fixed.
            const n = Number(text)
            if (text.trim() === '' || !Number.isFinite(n) || n === props.value) return false
            props.onCommit(n)
            return true
          }}
        />
        {/* Always there, empty for a bare number, so every field ends at the same edge. */}
        <span className="settings-unit">{props.unit}</span>
      </span>
    </Row>
  )
}

function WeightSelect(props: {
  label: string
  value: TerminalFontWeight
  disabled: boolean
  onChange: (w: TerminalFontWeight) => void
}): React.JSX.Element {
  const id = useId()
  return (
    <Row label={props.label} htmlFor={id}>
      <Select
        id={id}
        aria-label={`Terminal ${props.label.toLowerCase()}`}
        value={props.value}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.value as TerminalFontWeight)}
      >
        {TERMINAL_FONT_WEIGHTS.map((w) => (
          <option key={w} value={w}>
            {w}
          </option>
        ))}
      </Select>
    </Row>
  )
}
