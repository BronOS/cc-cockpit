import { useEffect, useRef, useState } from 'react'
import { AppearancePage } from './AppearancePage'
import { GeneralPage } from './GeneralPage'
import { BlocksIcon, CloseIcon, ContrastIcon, FolderIcon, GearIcon, KeyboardIcon, SlidersIcon, StoreIcon } from './icons'
import { KeybindingsPage } from './KeybindingsPage'
import { MarketplacePage } from './MarketplacePage'
import { PluginsPage } from './PluginsPage'
import { ProjectPage } from './ProjectPage'
import { ProjectsPage } from './ProjectsPage'
import type { SettingsTarget } from './settings-target'

/**
 * The pages of design-next §5.1, in its order; every setting lives on exactly one of them. The
 * Marketplace keeps its own section after Plugins until the two merge into one Plugins page.
 * General comes first and is where the screen opens: it holds what a person changes most.
 */
const SECTIONS = [
  { id: 'general', title: 'General', Icon: GearIcon },
  { id: 'appearance', title: 'Appearance', Icon: ContrastIcon },
  { id: 'keybindings', title: 'Keybindings', Icon: KeyboardIcon },
  { id: 'plugins', title: 'Plugins', Icon: BlocksIcon },
  { id: 'marketplace', title: 'Marketplace', Icon: StoreIcon },
  { id: 'project', title: 'This Project', Icon: SlidersIcon },
  { id: 'projects', title: 'Projects', Icon: FolderIcon }
] as const

type SectionId = (typeof SECTIONS)[number]['id']

/**
 * The settings screen (`Cmd+,`), a core overlay: it covers the window like the overlay stack's
 * overlays but lives in the renderer (no program or page behind it, so main has nothing to own).
 * It sits below the stack's z-index range, so an overlay opened while it shows (a plugin's
 * terminal overlay) appears on top of it. Esc, ✕ or `Cmd+Shift+W` closes it; `Cmd+,` toggles it
 * (TabsPane).
 */
export function SettingsOverlay(props: {
  onClose: () => void
  /** The screen's root, so TabsPane can give it the focus back after an overlay over it closes. */
  rootRef?: React.RefObject<HTMLDivElement | null>
  /** An overlay covers the screen: nothing here may take the keyboard meanwhile. */
  inert?: boolean
  /** A panel's gear (design-next §5.3): open at This Project (`project`) or Plugins (`app`) with that plugin's settings shown. */
  target?: SettingsTarget | null
}): React.JSX.Element {
  const [section, setSection] = useState<SectionId>(props.target ? (props.target.scope === 'project' ? 'project' : 'plugins') : 'general')
  // Only the section the screen was opened at: moving to another section by hand drops it.
  const openPlugin = props.target && section === (props.target.scope === 'project' ? 'project' : 'plugins') ? props.target.pluginId : undefined
  const own = useRef<HTMLDivElement>(null)
  const root = props.rootRef ?? own

  // Take the keyboard from the terminal behind, so Esc and Tab act here.
  useEffect(() => root.current?.focus(), [root])

  return (
    <div
      ref={root}
      className="settings"
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      tabIndex={-1}
      inert={props.inert}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !e.defaultPrevented) {
          e.preventDefault()
          props.onClose()
        }
      }}
    >
      {/* Its own sidebar and close button rather than the overlay stack's header bar
          (.overlay-header, which terminal overlays share): the title sits over the section list,
          the close button at the page's top right. */}
      <aside className="settings-sidebar">
        <div className="settings-sidebar-title">Settings</div>
        {/* Only the section buttons in here: the specs read the nav's buttons as the section list. */}
        <nav className="settings-nav" aria-label="Settings sections">
          {SECTIONS.map(({ id, title, Icon }) => (
            <button
              key={id}
              type="button"
              aria-current={id === section ? 'page' : undefined}
              className={id === section ? 'active' : undefined}
              onClick={() => setSection(id)}
            >
              <Icon />
              {title}
            </button>
          ))}
        </nav>
      </aside>
      <div className="settings-main">
        <button type="button" className="settings-close" aria-label="Close settings" title="Close (Esc)" onClick={props.onClose}>
          <kbd aria-hidden="true">esc</kbd>
          <CloseIcon size={14} />
        </button>
        {/* Keyed by section: a new section starts at its top, not at the last one's scroll. */}
        <div className="settings-page" key={section}>
          <div className="settings-content">
            {section === 'general' && <GeneralPage />}
            {section === 'appearance' && <AppearancePage />}
            {section === 'keybindings' && <KeybindingsPage />}
            {section === 'plugins' && <PluginsPage openPlugin={openPlugin} onOpenProject={() => setSection('project')} />}
            {section === 'marketplace' && <MarketplacePage onOpenProject={() => setSection('project')} />}
            {section === 'project' && <ProjectPage openPlugin={openPlugin} />}
            {section === 'projects' && <ProjectsPage />}
          </div>
        </div>
      </div>
    </div>
  )
}
