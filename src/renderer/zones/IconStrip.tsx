import { useEffect, useRef, useState } from 'react'
import { DRAG_THRESHOLD, dropIndex } from '../tabs/tab-drag'
import { chordKeys, chordOf } from '../commands/keybindings'
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
 * A plugin's icon drawn as a CSS mask over `currentColor`, so it takes the strip's colour and the
 * hover / open states like the core icons (an <img> would keep the file's own colours, black for
 * a stroke="currentColor" SVG). A mask reports no load errors, so a detached Image probe loads the
 * same url and tells PanelGlyph to fall back to the letter.
 */
export function MaskIcon({
  src,
  onFail,
  className = 'panel-icon-img'
}: {
  src: string
  onFail: (src: string) => void
  /** The size rule; `.panel-icon-img` (the strip's 18px) by default. A panel header action passes its own. */
  className?: string
}): React.JSX.Element {
  useEffect(() => {
    const probe = new Image()
    probe.onerror = () => onFail(src)
    probe.src = src
    return () => {
      probe.onerror = null
    }
  }, [src, onFail])
  const url = `url(${JSON.stringify(src)})`
  return (
    <span
      className={className}
      aria-hidden="true"
      style={{ maskImage: url, WebkitMaskImage: url }}
    />
  )
}

/**
 * A panel's glyph: the plugin's icon image when it has one, else its glyph or the title's first
 * letter. An image that fails to load (a broken file, a plugin whose folder is no longer served)
 * falls back to the letter rather than leaving an empty button.
 */
function PanelGlyph({ info }: { info: PanelInfo }): React.JSX.Element {
  const [failed, setFailed] = useState<string | undefined>(undefined)
  if (info.iconSrc && failed !== info.iconSrc) {
    return <MaskIcon src={info.iconSrc} onFail={setFailed} />
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
const MENU_HEIGHT = 190

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
  /**
   * Put a panel in `zone` at `index` among the icons that zone's strip shows without it (a menu's
   * Move up / down / to top, or a drag that ended over a strip). Zone.tsx maps it to the layout.
   */
  onPlace: (panelKey: string, zone: ZoneId, index: number) => void
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

  const drag = usePanelDrag(props.onPlace, () => setMenu(null))
  const menuIndex = menu?.kind === 'panel' ? placed.findIndex((p) => p.placement.panelKey === menu.panelKey) : -1

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
          onPointerDown={(e) => drag.press(e, placement.panelKey)}
          onClick={() => {
            // The click that ends a drag is not a toggle.
            if (drag.consumeClick()) return
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
          {/* Order inside this zone; an item that cannot do anything is disabled, not hidden,
              so the menu keeps its shape and a keyboard user sees why. */}
          {(
            [
              ['Move up', menuIndex <= 0, menuIndex - 1],
              ['Move down', menuIndex < 0 || menuIndex >= placed.length - 1, menuIndex + 1],
              ['Move to top', menuIndex <= 0, 0]
            ] as const
          ).map(([label, disabled, to]) => (
            <button
              key={label}
              type="button"
              role="menuitem"
              disabled={disabled}
              onClick={() => {
                setMenu(null)
                props.onPlace(menu.panelKey, zone, to)
              }}
            >
              {label}
            </button>
          ))}
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

/**
 * Drag an icon to reorder its strip or move it to another strip. Pointer events, not HTML5 drag
 * and drop (as TabBar.tsx, which explains why: a native drag session swallows the events and the
 * synthetic drags of the specs). A press moves nothing until the pointer travels DRAG_THRESHOLD, so
 * a click still toggles the panel. While dragging, one fixed line shows the slot the icon would
 * take, in whichever strip the pointer is over; Escape, a lost capture or a release off every
 * strip cancels. The state is imperative (a DOM line, a `data-dragging` attribute React does not
 * own) because the strips are separate components and the drag crosses them.
 */
function usePanelDrag(
  onPlace: (panelKey: string, zone: ZoneId, index: number) => void,
  closeMenu: () => void
): {
  press: (e: React.PointerEvent<HTMLButtonElement>, panelKey: string) => void
  consumeClick: () => boolean
} {
  const latest = useRef({ onPlace, closeMenu })
  useEffect(() => {
    latest.current = { onPlace, closeMenu }
  })
  const cleanup = useRef<(() => void) | null>(null)
  const swallow = useRef(false)
  // An unmount (the window closing) mid-drag must not leave the line or the key listener behind.
  useEffect(() => () => cleanup.current?.(), [])

  const press = (e: React.PointerEvent<HTMLButtonElement>, panelKey: string): void => {
    if (e.button !== 0 || cleanup.current) return
    const button = e.currentTarget
    const { pointerId, clientX: startX, clientY: startY } = e
    let dragging = false
    let target: { zone: ZoneId; index: number } | null = null
    let line: HTMLDivElement | null = null

    /** Where the pointer would drop the icon: strip, index among the strip's other icons, line rect. */
    const locate = (x: number, y: number): { zone: ZoneId; index: number; rect: DOMRect | null; vertical: boolean } | null => {
      const strip = document.elementFromPoint(x, y)?.closest<HTMLElement>('.icon-strip[data-zone]')
      const zone = strip?.dataset.zone as ZoneId | undefined
      if (!strip || !zone || !ZONE_IDS.includes(zone)) return null
      const horizontal = zone === 'bottom'
      const others = Array.from(strip.querySelectorAll<HTMLElement>('.panel-icon[data-panel]')).filter(
        (el) => el !== button
      )
      const rects = others.map((el) => el.getBoundingClientRect())
      const index = dropIndex(
        rects.map((r) => (horizontal ? r.left + r.width / 2 : r.top + r.height / 2)),
        horizontal ? x : y
      )
      const sr = strip.getBoundingClientRect()
      let at: number
      if (rects.length === 0) at = horizontal ? sr.left + 4 : sr.top + 4
      else if (index < rects.length) at = (horizontal ? rects[index]!.left : rects[index]!.top) - 2
      else at = (horizontal ? rects[index - 1]!.right : rects[index - 1]!.bottom) + 2
      const ref = rects[0] ?? sr
      const rect = horizontal
        ? new DOMRect(at - 1, sr.top + 4, 2, sr.height - 8)
        : new DOMRect(ref.left, at - 1, ref.width, 2)
      return { zone, index, rect, vertical: !horizontal }
    }
    // The icon's own slot is no drop: the order would stay, so show no line.
    const isOwnSlot = (zone: ZoneId, index: number): boolean => {
      const strip = button.closest<HTMLElement>('.icon-strip[data-zone]')
      if (strip?.dataset.zone !== zone) return false
      const all = Array.from(strip.querySelectorAll<HTMLElement>('.panel-icon[data-panel]'))
      return all.indexOf(button) === index
    }

    const onMove = (ev: PointerEvent): void => {
      if (ev.pointerId !== pointerId) return
      if (!dragging) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD) return
        dragging = true
        latest.current.closeMenu()
        // Keep the pointer's events on this icon when it leaves the strip, so the release is seen.
        try {
          button.setPointerCapture(pointerId)
        } catch {
          // The pointer is already gone (a cancelled touch): the drag ends at its next event.
        }
        button.dataset.dragging = 'true'
        line = document.createElement('div')
        line.className = 'panel-drop-line'
        line.setAttribute('aria-hidden', 'true')
        document.body.appendChild(line)
      }
      const at = locate(ev.clientX, ev.clientY)
      target = at && { zone: at.zone, index: at.index }
      if (!line) return
      if (!at || !at.rect || isOwnSlot(at.zone, at.index)) {
        line.style.display = 'none'
        return
      }
      line.style.display = 'block'
      line.style.left = `${at.rect.x}px`
      line.style.top = `${at.rect.y}px`
      line.style.width = `${at.rect.width}px`
      line.style.height = `${at.rect.height}px`
    }
    const end = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('keydown', onKey, true)
      button.removeEventListener('lostpointercapture', onCancel)
      line?.remove()
      delete button.dataset.dragging
      cleanup.current = null
      if (dragging) {
        // The click the release fires on the icon is not the person's toggle; it comes before any
        // timer, so clear the flag afterwards for a drag whose release landed elsewhere.
        swallow.current = true
        setTimeout(() => (swallow.current = false), 0)
      }
    }
    const onUp = (ev: PointerEvent): void => {
      if (ev.pointerId !== pointerId) return
      const drop = dragging ? target : null
      end()
      if (drop) latest.current.onPlace(panelKey, drop.zone, drop.index)
    }
    const onCancel = (): void => end()
    // Capture phase: Escape must cancel the drag before the strip's menu or a panel sees it.
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key !== 'Escape' || !dragging) return
      ev.stopPropagation()
      end()
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('keydown', onKey, true)
    button.addEventListener('lostpointercapture', onCancel)
    cleanup.current = end
  }

  return {
    press,
    consumeClick: () => {
      const v = swallow.current
      swallow.current = false
      return v
    }
  }
}
