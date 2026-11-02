// The settings screen's layout pieces and controls (styles: `.settings*` in styles.css). Pages
// are a header, then groups; a group is a heading over a card of hairline-divided rows; a row is a
// label with muted help on the left and its control on the right, as in macOS or Linear settings.
// The controls stay native elements (a <select>, an <input type="checkbox">) so their roles,
// keyboard behaviour and the e2e specs' getByRole('combobox' | 'checkbox') keep working; only the
// drawing changes.
import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react'
import { ChevronDownIcon } from './icons'

export function PageHeader(props: { title: ReactNode; description?: ReactNode }): React.JSX.Element {
  return (
    <header className="settings-page-header">
      <h2>{props.title}</h2>
      {props.description !== undefined && <p>{props.description}</p>}
    </header>
  )
}

/**
 * A titled group of settings. Not a <section>: the page is already a labelled region, and a
 * landmark per group would only lengthen a screen reader's landmark list.
 */
export function Group(props: {
  title: ReactNode
  description?: ReactNode
  /** Controls at the right of the heading (Reset to defaults). */
  actions?: ReactNode
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className="settings-group">
      <div className="settings-group-head">
        <div className="settings-group-title">
          <h3>{props.title}</h3>
          {props.description !== undefined && <p className="settings-group-desc">{props.description}</p>}
        </div>
        {props.actions !== undefined && <div className="settings-group-actions">{props.actions}</div>}
      </div>
      {props.children}
    </div>
  )
}

/**
 * One setting: label and help on the left, control on the right. `htmlFor` makes the label a
 * <label> for the control (a click on it focuses or toggles the control, and it names it); other
 * attributes (data-testid) go on the row.
 */
export function Row(
  props: {
    label: ReactNode
    htmlFor?: string
    help?: ReactNode
    children?: ReactNode
    className?: string
  } & Omit<React.HTMLAttributes<HTMLDivElement>, 'children' | 'className'>
): React.JSX.Element {
  const { label, htmlFor, help, children, className, ...rest } = props
  return (
    <div className={className ? `settings-row ${className}` : 'settings-row'} {...rest}>
      <div className="settings-row-text">
        {htmlFor !== undefined ? (
          <label className="settings-row-label" htmlFor={htmlFor}>
            {label}
          </label>
        ) : (
          <span className="settings-row-label">{label}</span>
        )}
        {help !== undefined && <div className="settings-row-help">{help}</div>}
      </div>
      {children !== undefined && <div className="settings-row-control">{children}</div>}
    </div>
  )
}

/**
 * A native <select> without the platform's drawing (appearance: none) and a chevron drawn over
 * its right end. The chevron is an inline SVG in currentColor rather than a CSS background image:
 * a data: URL could not follow the theme's colours.
 */
export function Select(props: SelectHTMLAttributes<HTMLSelectElement> & { wide?: boolean }): React.JSX.Element {
  const { wide, ...rest } = props
  return (
    <span className={wide ? 'settings-select wide' : 'settings-select'}>
      <select {...rest} />
      <ChevronDownIcon size={14} className="settings-select-chevron" />
    </span>
  )
}

/**
 * A boolean setting drawn as a switch. Still an <input type="checkbox"> with its native role (not
 * role="switch"): Space toggles it, a <label htmlFor> names it, and the specs find it as a checkbox.
 */
export function Switch(props: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>): React.JSX.Element {
  return <input {...props} type="checkbox" className="settings-switch" />
}

/** The quiet line a card shows when it has nothing to list. */
export function Empty(props: { children: ReactNode }): React.JSX.Element {
  return <p className="settings-empty">{props.children}</p>
}
