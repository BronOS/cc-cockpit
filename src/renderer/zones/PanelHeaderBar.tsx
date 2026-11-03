// What a plugin puts in its panel's title bar (ctx.panels.header, design §5 "Panel header"): a
// muted meta text after the title and up to three icon buttons before the panel's "…" menu
// (PanelArea.tsx). Main checked and built all of it (host-api.ts headerInfoOf); every string is
// drawn as React text, never as HTML. A click goes to main as `panels.action`, which checks it
// again against the header it holds and hands it to the plugin's onAction.
import { useState } from 'react'
import type { PanelHeaderActionInfo, PanelHeaderInfo } from '../../shared/ipc'
import type { PanelHeaderIconName } from '../../shared/panel-header'
import {
  CheckGlyph,
  ExternalGlyph,
  FilterGlyph,
  GearGlyph,
  PlusGlyph,
  ReloadGlyph,
  SearchGlyph,
  SortGlyph
} from '../window-icons'
import { MaskIcon } from './IconStrip'

/** The core icon set (shared/panel-header.ts PANEL_HEADER_ICONS), in the window's stroke style. */
const GLYPHS: Record<PanelHeaderIconName, (props: { size?: number }) => React.JSX.Element> = {
  refresh: ReloadGlyph,
  add: PlusGlyph,
  search: SearchGlyph,
  filter: FilterGlyph,
  settings: GearGlyph,
  'open-external': ExternalGlyph,
  check: CheckGlyph,
  sort: SortGlyph
}

/** The meta text: cut with an ellipsis when the header is narrow, the whole of it as tooltip. */
export function PanelHeaderMeta(props: { header: PanelHeaderInfo | undefined }): React.JSX.Element | null {
  const meta = props.header?.meta
  if (!meta) return null
  return (
    <span className="panel-meta panel-plugin-meta" title={meta}>
      {meta}
    </span>
  )
}

/**
 * A plugin's own .svg as a mask over the button's colour, like a panel icon in the strip. One that
 * fails to load (a missing file, a path that resolves outside the plugin folder and is refused by
 * cc-plugin://) shows the title's first letter instead of an empty button.
 */
function ActionIcon(props: { action: PanelHeaderActionInfo }): React.JSX.Element {
  const { action } = props
  const [failed, setFailed] = useState<string | undefined>(undefined)
  if (action.icon) {
    const Glyph = GLYPHS[action.icon]
    if (Glyph) return <Glyph />
  }
  if (action.iconSrc && failed !== action.iconSrc) {
    return <MaskIcon src={action.iconSrc} onFail={setFailed} className="panel-action-img" />
  }
  return (
    <span className="panel-action-letter" aria-hidden="true">
      {action.title.slice(0, 1).toUpperCase()}
    </span>
  )
}

/** The action buttons, in the plugin's order. */
export function PanelHeaderActions(props: { panelKey: string; header: PanelHeaderInfo | undefined }): React.JSX.Element | null {
  const actions = props.header?.actions
  if (!actions || actions.length === 0) return null
  return (
    <>
      {actions.map((action) => (
        <button
          key={action.id}
          type="button"
          className="panel-action icon-button sm"
          aria-label={action.title}
          title={action.title}
          data-action-id={action.id}
          // A busy action stays enabled to the eye (only its icon spins) but takes no click: not
          // `disabled`, which would dim it and drop it from the tab order mid-refresh.
          aria-busy={action.busy ? true : undefined}
          aria-disabled={action.busy ? true : undefined}
          disabled={action.disabled}
          onClick={() => {
            if (action.busy || action.disabled) return
            // A dropped click (false) needs nothing here: the header that refused it is on its way.
            window.cockpit.invoke('panels.action', { panelKey: props.panelKey, actionId: action.id }).catch(() => {})
          }}
        >
          <ActionIcon action={action} />
        </button>
      ))}
    </>
  )
}
