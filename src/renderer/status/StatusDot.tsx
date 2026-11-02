import type { TabStatus } from '../../shared/ipc'
import { statusLabel } from './strip-order'

/**
 * A status dot: the colour comes from `--cc-status-*` theme variables (styles.css gives each a
 * fallback, since a plugin theme may not define them), the tooltip names the status and the tool
 * being run. Hidden from assistive tech on purpose: inside a tab button it would prefix the tab's
 * accessible name ("idle Claude · app"), which tab lookups (and screen-reader users) rely on, and
 * a strip entry already spells the status out in text.
 */
export function StatusDot(props: { status: TabStatus; tool?: string }): React.JSX.Element {
  const label = statusLabel(props.status)
  const title = props.tool ? `${label} · ${props.tool}` : label
  return (
    <span
      className={`status-dot status-${props.status}`}
      aria-hidden="true"
      title={title}
      data-status={props.status}
    />
  )
}
