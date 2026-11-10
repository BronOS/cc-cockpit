import type { CSSProperties } from 'react'
import type { ProjectSummary, SlotFrameInfo } from '../../shared/ipc'
import { projectColorCss } from '../../shared/project-color'
import { SESSIONS_STRIP_SLOT, USAGE_METER_SLOT } from '../../shared/slots'
import { FolderGlyph, GearGlyph, PlusGlyph } from '../window-icons'
import { SlotFrame } from '../zones/SlotFrame'
import { ProjectDot } from './ProjectDot'
import { topStripClass } from './strip-order'
import { WebAccessChip } from './WebAccessChip'

/**
 * The bar across the top of every project window (variant A, "unified bar"): the project's name
 * and folder, the app slot `sessions-strip`, a "+", the app slot `usage-meter` and the gear.
 *
 * The other windows' Claude tabs are not drawn here any more (design-next §4): a plugin draws them
 * in the `sessions-strip` slot (the bundled `cockpit.sessions` by default; main sends the frame in
 * `LayoutView.appSlots`), between the project name and the "+", with the bar's height and the width
 * its page reports (`ccPanel.slot.setWidth`), capped so a drag gap is always left before the "+"
 * (SlotFrame, styles.css `.slot-frame-top-bar`). With no provider (the plugin off, the pick "None") there is no frame and the bar is the
 * name, the "+" and the gear. A frame takes room only once main handed its page a port
 * (SlotFrame `collapseUntilConnected`): a frame whose connect main refuses (its provider not running)
 * leaves the same bar as no provider, rather than a blank gap that (on macOS) would not even drag
 * the window.
 *
 * On macOS it is also the window's title bar (`titleBar`): main hides the native one
 * (window-chrome.ts), so the bar leaves room for the traffic lights and is a drag region, with
 * every control in it marked no-drag (styles.css). Elsewhere the native title bar stays and this
 * is the same bar without that room.
 *
 * The `usage-meter` slot (the plan's usage, the bundled `cockpit.usage` by default) sits at the
 * bar's end before the gear, with the bar's height and the width its page reports, capped in CSS
 * (`.titlebar-end .slot-frame-top-bar`) so it never crowds the strip; the same frame rules as the
 * strip (collapsed until connected, nothing without a provider or with the pick "None").
 *
 * The "+" asks main to show the project picker (recent projects + Open Folder), so another project
 * is one click away from any window; it is always there, so the bar is always shown.
 * The web access chip (WebAccessChip) sits before the gear while a browser is connected or a risky
 * choice is on, and is not drawn otherwise. The gear
 * opens settings; it sits outside the slot's space so a wide strip never pushes it out of view.
 *
 * A project with a colour (Settings › This Project) marks its bar three ways: a 3px line along
 * the window's top edge, a faint tint of the whole bar, and a dot by its name. The bar carries the
 * colour as `--cc-project-color` with `data-project-color` set (styles.css); with no colour neither
 * is set and the bar is as it always was.
 */
export function TopStrip(props: {
  /** The window's project: its name and folder lead the bar. Absent in nothing but a test page. */
  project?: ProjectSummary
  /** macOS: the bar is the window's title bar (room for the traffic lights, drag region). */
  titleBar?: boolean
  /** Full screen: macOS hides the traffic lights, so their room collapses. */
  fullScreen?: boolean
  /** The app's slot frames (`LayoutView.appSlots`); the top bar draws the `top-bar` ones by type. */
  slots?: readonly SlotFrameInfo[]
  /** The "+": show (or focus) the project picker. */
  onOpenProject: () => void
  /** The gear: the same toggle as the app.openSettings command (menu, Cmd+,). */
  onOpenSettings: () => void
  /** A modal screen covers the window (settings): the bar's controls may not take the focus. */
  inert?: boolean
}): React.JSX.Element {
  const slot = props.slots?.find((f) => f.position === 'top-bar' && f.type === SESSIONS_STRIP_SLOT)
  const meter = props.slots?.find((f) => f.position === 'top-bar' && f.type === USAGE_METER_SLOT)
  const { project } = props
  const color = project?.color
  return (
    // A <header> holding the <nav> rather than one nav: the project's name is the window's title,
    // not a session, and the specs find the strip by the nav's label.
    <header
      className={topStripClass(props.titleBar === true, props.fullScreen === true)}
      inert={props.inert}
      data-project-color={color}
      style={color === undefined ? undefined : ({ '--cc-project-color': projectColorCss(color) } as CSSProperties)}
    >
      {project && (
        // The path in full, not with `~`: project windows are not told the home folder (only the
        // picker is), and the name already says which project this is.
        <div className="titlebar-project" title={project.path}>
          <FolderGlyph />
          <ProjectDot color={color} announce />
          <span className="titlebar-project-name">{project.name}</span>
          <span className="titlebar-project-path">{project.path}</span>
        </div>
      )}
      <nav className={slot ? 'strip-nav has-slot' : 'strip-nav'} aria-label="Claude sessions">
        {slot && <SlotFrame key={slot.id} frame={slot} collapseUntilConnected />}
        <div className="strip-list">
          <button
            type="button"
            className="strip-open-project icon-button sm"
            aria-label="Open project…"
            title="Open project…"
            onClick={props.onOpenProject}
          >
            <PlusGlyph size={14} />
          </button>
        </div>
      </nav>
      <div className={meter ? 'titlebar-end has-slot' : 'titlebar-end'}>
        {meter && <SlotFrame key={meter.id} frame={meter} collapseUntilConnected />}
        <WebAccessChip onOpen={props.onOpenSettings} />
        <button
          type="button"
          className="strip-settings icon-button"
          aria-label="Settings"
          title="Settings"
          onClick={props.onOpenSettings}
        >
          <GearGlyph />
        </button>
      </div>
    </header>
  )
}
