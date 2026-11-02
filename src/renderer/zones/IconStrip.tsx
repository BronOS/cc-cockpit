import { useEffect, useRef, useState } from 'react'
import { chordKeys, chordOf } from '../commands/keybindings'
import { SessionsGlyph } from '../window-icons'
import type { PanelInfo } from '../../shared/ipc'
import { ZONE_IDS, type PanelPlacement, type ZoneId } from '../../shared/layout'
import { useShellLayer } from './use-shell-layer'

const ZONE_NAMES: Record<ZoneId, string> = { left: 'Left', right: 'Right', bottom: 'Bottom' }

/** What a panel's button says to a screen reader: title, then badge and error when there are any. */
export function panelLabel(info: PanelInfo): string {
  let label = info.title
  if (info.badge?.kind === 'count') label += `, ${info.badge.count} new`
  else if (info.badge?.kind === 'dot') label += ', needs you'
  if (info.error) label += ', has an error'
  return label
}

/**
 * A panel's glyph: the plugin's icon image when it has one, else its glyph or the title's first
 * letter. An image that fails to load (a broken file, a plugin whose folder is no longer served)
 * falls back to the letter rather than leaving an empty button.
 */
function PanelGlyph({ info }: { info: PanelInfo }): React.JSX.Element {
  const [failed, setFailed] = useState<string | undefined>(undefined)
  // The core Sessions panel is the app's own: a stroke glyph in the window's vocabulary rather
  // than its letter "S" (layout-service.ts keeps `icon: 'S'` for the PanelInfo contract; plugins
  // keep the icon they ship).
  if (info.panelKey === 'core/sessions') {
    return <SessionsGlyph size={17} />
  }
  if (info.iconSrc && failed !== info.iconSrc) {
    const src = info.iconSrc
    return (
      <img
        className="panel-icon-img"
        src={src}
        alt=""
        aria-hidden="true"
        draggable={false}
        onError={() => setFailed(src)}
      />
    )
  }
  // A letter is drawn in a rounded square, so a panel without an icon still reads as an icon.
  return (
    <span className="panel-icon-letter" aria-hidden="true">
      {info.icon ?? info.title.slice(0, 1).toUpperCase()}
    </span>
  )
}

/**
 * Room reserved for the context menu (three items) when clamping it into the window; also where
 * a header's "…" puts the menu's left edge (PanelArea). Matches `.context-menu`'s min-width.
 */
export const MENU_WIDTH = 168
const MENU_HEIGHT = 120

/**
 * A collapsed bottom zone is a bar of icons only, easy to take for a status bar: say what it is,
 * with the key that opens it (zone.toggleBottom, user overrides applied; no keycaps when unbound).
 * Only the bottom strip: the side strips are too narrow for a caption.
 */
function CollapsedCaption(): React.JSX.Element {
  const key = chordOf('zone.toggleBottom')
  const mac = navigator.platform.toLowerCase().includes('mac')
  return (
    <span className="zone-caption">
      Bottom zone collapsed
      {key && (
        <span className="keys" aria-hidden="true">
          {chordKeys(key, mac).map((k, i) => (
            <kbd key={i}>{k}</kbd>
          ))}
        </span>
      )}
    </span>
  )
}

export type MenuState =
  | { kind: 'panel'; panelKey: string; x: number; y: number }
  | { kind: 'hidden' }

/**
 * Marks a control outside the strip that opens this zone's menu (a panel header's "…" button,
 * PanelArea.tsx): the strip's outside-click dismiss must skip it, or the click that opened the
 * menu would bubble to the window listener and close it again at once.
 */
export const ZONE_MENU_TRIGGER = 'data-zone-menu'

/**
 * The icon strip of one zone: a button per placed panel (click toggles it, right-click opens
 * move / hide), then a "..." button that lists the hidden panels. A badge (count or dot) and a
 * warning mark for a plugin error sit on the icon.
 *
 * The menu state is the zone's (Zone.tsx), not the strip's: a panel header's "…" button opens the
 * same move / hide menu as the right-click here, and one zone shows one menu at a time.
 */
export function IconStrip(props: {
  zone: ZoneId
  /** The panels placed in this zone, in order, with whether each is open. */
  placed: Array<{ placement: PanelPlacement; info: PanelInfo }>
  hidden: PanelInfo[]
  onToggle: (panelKey: string) => void
  onMove: (panelKey: string, zone: ZoneId) => void
  onHide: (panelKey: string) => void
  onUnhide: (panelKey: string) => void
  menu: MenuState | null
  setMenu: (menu: MenuState | null) => void
  /** The zone is collapsed: the bottom strip says so, with the key that opens it. */
  collapsed?: boolean
}): React.JSX.Element {
  const { zone, placed, hidden, menu, setMenu } = props
  const root = useRef<HTMLDivElement>(null)
  // A webview panel's native view would paint over the menu (shell-layers.ts).
  useShellLayer(menu !== null)

  // A click or right-click outside this strip, or Escape, closes the menu. Clicks inside the strip
  // (its icons, "...", the menu itself) handle the menu themselves, so they are skipped here
  // rather than stopped: a stopPropagation would also keep the OTHER strips' dismiss from running,
  // leaving two menus open at once.
  const open = menu !== null
  useEffect(() => {
    if (!open) return
    const dismiss = (e: Event): void => {
      if (e.target instanceof Node && root.current?.contains(e.target)) return
      if (e.target instanceof Element && e.target.closest(`[${ZONE_MENU_TRIGGER}="${zone}"]`)) return
      setMenu(null)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenu(null)
    }
    window.addEventListener('click', dismiss)
    // A right-click fires no click: without this, opening another strip's menu kept this one.
    window.addEventListener('contextmenu', dismiss)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', dismiss)
      window.removeEventListener('contextmenu', dismiss)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, zone, setMenu])

  return (
    <div
      ref={root}
      className={`icon-strip icon-strip-${zone}`}
      role="toolbar"
      aria-label={`${ZONE_NAMES[zone]} panels`}
      data-zone={zone}
    >
      {placed.map(({ placement, info }) => (
        <button
          key={placement.panelKey}
          type="button"
          className={`panel-icon${placement.open ? ' open' : ''}`}
          aria-label={panelLabel(info)}
          aria-pressed={placement.open}
          title={info.title}
          data-panel={placement.panelKey}
          onClick={() => {
            setMenu(null)
            props.onToggle(placement.panelKey)
          }}
          onContextMenu={(e) => {
            e.preventDefault()
            setMenu({ kind: 'panel', panelKey: placement.panelKey, x: e.clientX, y: e.clientY })
          }}
        >
          <PanelGlyph info={info} />
          {info.badge?.kind === 'count' && (
            <span className="panel-badge" aria-hidden="true">
              {info.badge.count > 99 ? '99+' : info.badge.count}
            </span>
          )}
          {info.badge?.kind === 'dot' && <span className="panel-badge panel-badge-dot" aria-hidden="true" />}
          {info.error && (
            <span className="panel-error" aria-hidden="true" title={info.error}>
              ⚠
            </span>
          )}
        </button>
      ))}
      <button
        type="button"
        className="panel-icon panel-more"
        aria-label="Hidden panels"
        aria-haspopup="menu"
        aria-expanded={menu?.kind === 'hidden'}
        title="Hidden panels"
        onClick={() => setMenu(menu?.kind === 'hidden' ? null : { kind: 'hidden' })}
      >
        <span aria-hidden="true">···</span>
      </button>
      {zone === 'bottom' && props.collapsed && <CollapsedCaption />}
      {menu?.kind === 'panel' && (
        <div
          role="menu"
          className="menu context-menu"
          // A strip at the window's bottom or right edge would put the menu off screen, out of reach.
          style={{
            left: Math.max(0, Math.min(menu.x, window.innerWidth - MENU_WIDTH)),
            top: Math.max(0, Math.min(menu.y, window.innerHeight - MENU_HEIGHT))
          }}
        >
          {ZONE_IDS.filter((z) => z !== zone).map((z) => (
            <button
              key={z}
              type="button"
              role="menuitem"
              onClick={() => {
                setMenu(null)
                props.onMove(menu.panelKey, z)
              }}
            >
              Move to {ZONE_NAMES[z].toLowerCase()}
            </button>
          ))}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenu(null)
              props.onHide(menu.panelKey)
            }}
          >
            Hide
          </button>
        </div>
      )}
      {menu?.kind === 'hidden' && (
        <div role="menu" aria-label="Hidden panels" className="menu strip-menu" data-zone={zone}>
          {hidden.length === 0 && (
            <span className="menu-empty" role="none">
              No hidden panels
            </span>
          )}
          {hidden.map((info) => (
            <button
              key={info.panelKey}
              type="button"
              role="menuitem"
              onClick={() => {
                setMenu(null)
                props.onUnhide(info.panelKey)
              }}
            >
              {info.title}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
