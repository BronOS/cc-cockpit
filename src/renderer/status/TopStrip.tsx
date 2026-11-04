import { useMemo, type CSSProperties } from 'react'
import type { ProjectSummary, SessionStripEntry, SlotFrameInfo } from '../../shared/ipc'
import { projectColorCss } from '../../shared/project-color'
import { FolderGlyph, GearGlyph, PlusGlyph } from '../window-icons'
import { SlotFrame } from '../zones/SlotFrame'
import { ProjectDot } from './ProjectDot'
import { StatusDot } from './StatusDot'
import { orderStrip, stripText, topStripClass } from './strip-order'

/**
 * The bar across the top of every project window (variant A, "unified bar"): the project's name
 * and folder, then the Claude tabs of the OTHER windows, most urgent first, then the gear. It is fed
 * by the per-window snapshot, so another project's tab arrives with the strip fields only
 * (project name, status, tool). A click asks main to focus that tab's window and select the tab;
 * main finds the window itself, the entry's tab id is the only thing sent.
 *
 * On macOS it is also the window's title bar (`titleBar`): main hides the native one
 * (window-chrome.ts), so the bar leaves room for the traffic lights and is a drag region, with
 * every control in it marked no-drag (styles.css). Elsewhere the native title bar stays and this
 * is the same bar without that room.
 *
 * The entries end with a "+" that asks main to show the project picker (recent projects + Open
 * Folder), so another project is one click away from any window. The bar is therefore always
 * shown, also with no Claude tab anywhere: hiding it then would hide the "+" too. The gear opens
 * settings; it sits outside the scrolling list so many tabs never push it out of view.
 *
 * A project with a colour (Settings › This project) marks its bar three ways: a 3px line along
 * the window's top edge, a faint tint of the whole bar, and a dot by its name; each other window's
 * entry has a dot in its project's colour (from the snapshot, so a change there arrives live).
 * The bar carries the colour as `--cc-project-color` with `data-project-color` set (styles.css);
 * with no colour neither is set and the bar is as it always was.
 *
 * The app slot `sessions-strip` (design-next §2, §4): when a plugin draws it (main sends the frame
 * in `LayoutView.appSlots`), its page takes the place of the built-in entries, between the project
 * name and the "+", with the bar's height and the width left. Both show the other windows' Claude
 * tabs, so drawing the two would list them twice. With no provider (or the pick "None") the
 * built-in entries stay.
 */
export function TopStrip(props: {
  /** The window's project: its name and folder lead the bar. Absent in nothing but a test page. */
  project?: ProjectSummary
  /** macOS: the bar is the window's title bar (room for the traffic lights, drag region). */
  titleBar?: boolean
  /** Full screen: macOS hides the traffic lights, so their room collapses. */
  fullScreen?: boolean
  /** Other windows' Claude tabs only (the caller filters; this window's own are in its tab bar). */
  entries: readonly SessionStripEntry[]
  /** The app's slot frames (`LayoutView.appSlots`); the top bar draws the `top-bar` one. */
  slots?: readonly SlotFrameInfo[]
  onFocus: (tabId: string) => void
  /** The "+": show (or focus) the project picker. */
  onOpenProject: () => void
  /** The gear: the same toggle as the app.openSettings command (menu, Cmd+,). */
  onOpenSettings: () => void
  /** A modal screen covers the window (settings): the entries may not take the focus. */
  inert?: boolean
}): React.JSX.Element {
  const ordered = useMemo(() => orderStrip(props.entries), [props.entries])
  const slot = props.slots?.find((f) => f.position === 'top-bar')
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
        {slot && <SlotFrame key={slot.id} frame={slot} />}
        <div className="strip-list">
          {(slot ? [] : ordered).map((entry) => {
            const text = stripText(entry)
            return (
              <button
                key={entry.tabId}
                type="button"
                className="strip-entry"
                data-status={entry.status}
                title={text}
                onClick={() => props.onFocus(entry.tabId)}
              >
                <StatusDot status={entry.status} {...(entry.tool ? { tool: entry.tool } : {})} />
                {/* The project name set apart in weight only: the text is stripText's, so the
                    entry's accessible name and text stay exactly what they were. */}
                <span className="strip-text">
                  <ProjectDot color={entry.projectColor} />
                  <span className="strip-project">{entry.projectName}</span>
                  {text.slice(entry.projectName.length)}
                </span>
              </button>
            )
          })}
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
      <div className="titlebar-end">
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
