// The project pickers' shared look: the desktop picker window (ProjectPicker.tsx) and server mode's
// browser picker (web/picker.tsx) draw their header, panels, rows and states from these, with the
// classes in styles.css (`.picker-*`), so a change to how a project row looks reaches both. What each
// picker does on a click (an IPC call on the desktop, a POST or a link in the browser) stays with it:
// these are presentational only, no data and no calls.
import type { ReactNode } from 'react'
import type { ProjectColor } from '../../shared/project-color'
import { ProjectDot } from '../status/ProjectDot'
import { AppIcon, FolderGlyph, SearchGlyph } from './icons'

/** The app icon, the name and a tagline, then the header's buttons (`children`). */
export function PickerHeader(props: { tagline: ReactNode; children?: ReactNode }): React.JSX.Element {
  return (
    <header className="picker-header">
      <AppIcon size={56} />
      <div className="picker-title">
        <h1>cc-cockpit</h1>
        <p className="picker-tagline">{props.tagline}</p>
      </div>
      {props.children}
    </header>
  )
}

/** The picker's error banner (an alert: read out when it appears). */
export function PickerError(props: { children: ReactNode }): React.JSX.Element {
  return (
    <p role="alert" className="picker-error">
      {props.children}
    </p>
  )
}

/** A titled card of rows (the recent projects): the title above, the panel holding the search, list or empty text. */
export function PickerSection(props: { id: string; title: string; children: ReactNode; className?: string }): React.JSX.Element {
  return (
    <section className={`picker-recent${props.className ? ` ${props.className}` : ''}`} aria-labelledby={props.id}>
      <h2 id={props.id}>{props.title}</h2>
      <div className="picker-panel">{props.children}</div>
    </section>
  )
}

/** The text in an empty panel, centred in the room the list would take. */
export function PickerEmpty(props: { children: ReactNode }): React.JSX.Element {
  return <p className="picker-empty">{props.children}</p>
}

/** The filter field at the head of a panel, with its magnifier. */
export function PickerSearch(
  props: Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'className'> & { label: string }
): React.JSX.Element {
  const { label, ...input } = props
  return (
    <label className="picker-search">
      <SearchGlyph />
      <input type="text" spellCheck={false} aria-label={label} {...input} />
    </label>
  )
}

export interface ProjectRowProps {
  /** The DOM id of the row's control; `<id>-name` and `<id>-path` name and describe it. */
  rowId: string
  name: string
  /** The path as the row shows it (`~` for home). */
  path: string
  /** The tooltip: the whole path, and that the folder is missing. */
  title: string
  color?: ProjectColor | undefined
  /** The folder is gone: the row steps back, its control is disabled, the badge shows. */
  missing: boolean
  /** The keyboard's row: tinted, with the ↵ hint. */
  highlighted: boolean
  /** A link instead of a button (the browser's open projects: a plain link opens in a new browser tab too). */
  href?: string
  /** The button's click (ignored with `href`). */
  onOpen?: () => void
  /** The pointer moved over the row (the desktop picker moves its highlight there). */
  onHover?: () => void
  /** Disabled while another open is under way (missing rows are always disabled). */
  disabled?: boolean
  /** A short note at the row's right before ↵ ("3 days ago"); absent on the desktop. */
  meta?: string
  /** Buttons after the row's control (Relink… and Forget for a missing folder), or an inline confirm. */
  actions?: ReactNode
}

/**
 * One project: folder glyph, colour dot, name (the control's whole accessible name: specs and screen
 * readers find a project by it), path, and for a missing folder its badge. The control fills the row,
 * so a click anywhere on it opens the project.
 */
export function ProjectRow(props: ProjectRowProps): React.JSX.Element {
  const { rowId, missing } = props
  const body = (
    <>
      <FolderGlyph />
      <span className="picker-row-text">
        <span className="picker-row-line">
          <ProjectDot color={props.color} />
          <span className="picker-row-name" id={`${rowId}-name`}>
            {props.name}
          </span>
          {missing && (
            <span className="picker-badge" aria-hidden="true">
              missing
            </span>
          )}
        </span>
        <span className="picker-row-path" id={`${rowId}-path`}>
          {props.path}
          {missing && <span className="visually-hidden"> (missing)</span>}
        </span>
      </span>
      {props.meta !== undefined && <span className="picker-row-meta">{props.meta}</span>}
      {!missing && (
        <kbd className="picker-enter" aria-hidden="true">
          ↵
        </kbd>
      )}
    </>
  )
  const control =
    props.href !== undefined && !missing ? (
      <a id={rowId} className="picker-open" href={props.href} aria-labelledby={`${rowId}-name`} aria-describedby={`${rowId}-path`} title={props.title}>
        {body}
      </a>
    ) : (
      <button
        type="button"
        id={rowId}
        className="picker-open"
        disabled={missing || props.disabled === true}
        aria-labelledby={`${rowId}-name`}
        aria-describedby={`${rowId}-path`}
        title={props.title}
        onClick={props.onOpen}
      >
        {body}
      </button>
    )
  return (
    <li className={`picker-row${missing ? ' missing' : ''}${props.highlighted ? ' highlighted' : ''}`} onMouseMove={props.onHover}>
      {control}
      {props.actions}
    </li>
  )
}
