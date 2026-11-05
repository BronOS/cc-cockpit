import { useState } from 'react'
import { TAB_COMMAND_LABEL_MAX, TAB_COMMAND_MAX, TAB_COMMANDS_MAX } from '../../shared/tab-commands'
import type { TabCommandEntry, TabCommandLevel, TabCommandOpen } from '../../shared/types'
import { ArrowDownIcon, ArrowUpIcon, TrashIcon } from './icons'
import { Select } from './ui'
import type { Action } from './use-action'

type Draft = { id?: string; label: string; command: string; open: TabCommandOpen }

/** The Tab / Overlay pick of an entry (design §3 Custom commands): where the [+] menu opens it. */
function OpenSelect(props: {
  value: TabCommandOpen
  label: string
  onChange: (open: TabCommandOpen) => void
}): React.JSX.Element {
  return (
    <Select
      aria-label={props.label}
      title="Open as a tab, or as an overlay over the tabs that closes when the program exits"
      value={props.value}
      onChange={(e) => props.onChange(e.target.value === 'overlay' ? 'overlay' : 'tab')}
    >
      <option value="tab">Tab</option>
      <option value="overlay">Overlay</option>
    </Select>
  )
}

/**
 * The editable list of one level's new-tab menu entries (design §3 Tabs, "Custom commands"):
 * Settings › General for the app-wide ones, Settings › This Project for the
 * project's. Every change (add, edit, remove, move) sends the whole list to main, which checks it,
 * keeps the ids of the entries it already has and mints new ones (TabCommandsService.set); the
 * page then reloads what main stored. An edit is sent with Enter or its Save button, not on blur:
 * a blur that saved would also eat the click on another row's button (one action at a time).
 *
 * Drawn as a table in a card: a column header, one grid row per entry whose fields look like
 * plain text until hovered or focused, and the add row at the foot. Every row shares the grid
 * columns (`.tab-commands` in styles.css), so the fields line up under their headings.
 */
export function TabCommandsEditor(props: {
  level: TabCommandLevel
  /** Accessible name of the list ("App-wide commands", "Project commands"). */
  name: string
  entries: TabCommandEntry[]
  busy: string | null
  run: Action['run']
  reload: () => void
}): React.JSX.Element {
  const { level, name, entries, busy, run, reload } = props
  const [label, setLabel] = useState('')
  const [command, setCommand] = useState('')
  const [open, setOpen] = useState<TabCommandOpen>('tab')
  const action = `tabCommands ${level}`

  const save = (next: Draft[]): Promise<boolean> =>
    run(action, () => window.cockpit.invoke('settings.tabCommandsSet', { level, entries: next })).then((stored) => {
      reload()
      return stored !== undefined
    })
  // Every entry carries its `open` back: a list sent without it would turn overlays into tabs.
  const drafts = (): Draft[] => entries.map(({ id, label, command, open }) => ({ id, label, command, open: open ?? 'tab' }))
  const move = (index: number, delta: -1 | 1): void => {
    const next = drafts()
    const [entry] = next.splice(index, 1)
    next.splice(index + delta, 0, entry!)
    void save(next)
  }
  const add = (): void => {
    void save([...drafts(), { label, command, open }]).then((ok) => {
      if (!ok) return
      setLabel('')
      setCommand('')
      setOpen('tab')
    })
  }

  return (
    <div className="tab-commands settings-card" data-level={level}>
      {entries.length === 0 ? (
        <p className="settings-empty">None yet.</p>
      ) : (
        <>
          <div className="tab-commands-head" aria-hidden="true">
            <span>Label</span>
            <span>Command line</span>
            <span>Opens as</span>
          </div>
          <ul className="settings-list" aria-label={name}>
            {entries.map((entry, i) => (
              <TabCommandRow
                key={`${entry.id}\0${entry.label}\0${entry.command}\0${entry.open ?? 'tab'}`}
                entry={entry}
                index={i}
                last={i === entries.length - 1}
                disabled={busy !== null}
                onSave={(next) => save(drafts().map((d, j) => (j === i ? { ...d, ...next } : d)))}
                onMove={(delta) => move(i, delta)}
                onRemove={() => void save(drafts().filter((_, j) => j !== i))}
              />
            ))}
          </ul>
        </>
      )}
      {entries.length < TAB_COMMANDS_MAX && (
        <form
          className="tab-command-grid tab-command-add"
          onSubmit={(e) => {
            e.preventDefault()
            add()
          }}
        >
          <input
            type="text"
            aria-label={`New ${name.toLowerCase()} label`}
            placeholder="Label"
            maxLength={TAB_COMMAND_LABEL_MAX}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <input
            type="text"
            className="mono"
            aria-label={`New ${name.toLowerCase()} command line`}
            placeholder="Command line, e.g. lazygit or npm run dev"
            maxLength={TAB_COMMAND_MAX}
            value={command}
            onChange={(e) => setCommand(e.target.value)}
          />
          <OpenSelect value={open} label={`New ${name.toLowerCase()} opens as`} onChange={setOpen} />
          <button type="submit" className="tab-command-submit" disabled={busy !== null || label.trim() === '' || command.trim() === ''}>
            Add
          </button>
        </form>
      )}
    </div>
  )
}

function TabCommandRow(props: {
  entry: TabCommandEntry
  index: number
  last: boolean
  disabled: boolean
  onSave: (next: { label: string; command: string; open: TabCommandOpen }) => Promise<boolean>
  onMove: (delta: -1 | 1) => void
  onRemove: () => void
}): React.JSX.Element {
  const { entry, index, last, disabled } = props
  // The draft starts from what main stored; the list keys a row by the stored text too, so a save
  // (here or in another window) starts a fresh draft, while a failed save changes nothing stored
  // and the draft stays for the user to fix. Tab / Overlay is part of the draft and saved with
  // Save like the text: saving it on change would rebuild the row and drop an unsaved text edit.
  const stored = entry.open ?? 'tab'
  const [label, setLabel] = useState(entry.label)
  const [command, setCommand] = useState(entry.command)
  const [open, setOpen] = useState<TabCommandOpen>(stored)
  const dirty = label !== entry.label || command !== entry.command || open !== stored

  return (
    <li className="tab-command-grid tab-command-item" data-entry={entry.id}>
      {/* display: contents (styles.css): the form's fields are cells of the row's grid. */}
      <form
        className="tab-command-form"
        onSubmit={(e) => {
          e.preventDefault()
          if (dirty) void props.onSave({ label, command, open })
        }}
      >
        <input
          type="text"
          aria-label={`Label of command ${index + 1}`}
          maxLength={TAB_COMMAND_LABEL_MAX}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <input
          type="text"
          className="mono"
          aria-label={`Command line of command ${index + 1}`}
          maxLength={TAB_COMMAND_MAX}
          value={command}
          onChange={(e) => setCommand(e.target.value)}
        />
        <OpenSelect value={open} label={`Command ${index + 1} opens as`} onChange={setOpen} />
        {dirty && (
          <button type="submit" className="primary tab-command-submit" disabled={disabled}>
            Save
          </button>
        )}
      </form>
      <div className="tab-command-actions">
        <button
          type="button"
          className="icon quiet"
          aria-label={`Move ${entry.label} up`}
          title="Move up"
          disabled={disabled || index === 0}
          onClick={() => props.onMove(-1)}
        >
          <ArrowUpIcon size={14} />
        </button>
        <button
          type="button"
          className="icon quiet"
          aria-label={`Move ${entry.label} down`}
          title="Move down"
          disabled={disabled || last}
          onClick={() => props.onMove(1)}
        >
          <ArrowDownIcon size={14} />
        </button>
        <button
          type="button"
          className="icon quiet danger"
          aria-label={`Remove ${entry.label}`}
          title="Remove"
          disabled={disabled}
          onClick={props.onRemove}
        >
          <TrashIcon size={14} />
        </button>
      </div>
    </li>
  )
}
