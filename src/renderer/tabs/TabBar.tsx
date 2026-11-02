import { useEffect, useState } from 'react'
import type { SessionDetail, TabCommandMenu, TabInfo } from '../../shared/ipc'
import type { TabCommandLevel } from '../../shared/types'
import { splitChord } from '../../shared/keys'
import { chordKeys, chordOf } from '../commands/keybindings'
import { usePrefs } from '../prefs/prefs-store'
import { QueuedChip } from '../status/QueuedChip'
import { StatusDot } from '../status/StatusDot'
import { useShellLayer } from '../zones/use-shell-layer'
import { CloseGlyph, CommandGlyph, PlusGlyph, ShellGlyph } from '../window-icons'
import { tabLabel } from './tab-label'

/** What the [+] menu lists after Claude and Shell: the user's entries, app-wide then project. */
const COMMAND_GROUPS: Array<{ level: TabCommandLevel; name: string }> = [
  { level: 'app', name: 'App commands' },
  { level: 'project', name: 'Project commands' }
]

const mac = (): boolean => navigator.platform.toLowerCase().includes('mac')

/** A canonical chord (`shift+meta+l`) as aria-keyshortcuts writes it (`Shift+Meta+L`); `+` is `Plus` there. */
function ariaShortcut(chord: string): string | undefined {
  const parts = splitChord(chord)
  if (!parts) return undefined
  const cap = (p: string): string => (p === '+' ? 'Plus' : p.charAt(0).toUpperCase() + p.slice(1))
  return [...parts.mods, parts.key].map(cap).join('+')
}

/**
 * A chord as keycaps, one per key (⇧ ⌘ T). Hidden from assistive tech, which reads the row's
 * aria-keyshortcuts instead. On macOS the caps carry exactly displayChord's text (it joins with
 * nothing there); elsewhere the `+` stays between them as text, so the row's text reads as before.
 */
function Keys(props: { chord: string }): React.JSX.Element {
  const isMac = mac()
  const keys = chordKeys(props.chord, isMac)
  return (
    <span className="keys" aria-hidden="true">
      {keys.map((k, i) => (
        <span key={i} className="key-part">
          {i > 0 && !isMac && <span className="key-sep">+</span>}
          <kbd>{k}</kbd>
        </span>
      ))}
    </span>
  )
}

/**
 * The [+] menu's left-hand mark: where the entry opens. Every row carries one (Claude and Shell are
 * tabs too) so labels line up and the overlay rows stand out by shape, not by an extra word.
 * Drawn with currentColor so it follows the theme; hidden from assistive tech, which gets
 * `aria-description` on overlay rows instead.
 */
function OpenIcon(props: { open: 'tab' | 'overlay' }): React.JSX.Element {
  return (
    <svg
      className="menu-icon"
      data-open={props.open}
      viewBox="0 0 16 16"
      width="14"
      height="14"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinejoin="round"
    >
      {props.open === 'tab' ? (
        // A window with a tab raised on its top-left edge.
        <path d="M1.5 5.5h13v8h-13zM1.5 5.5v-3h6v3" />
      ) : (
        // Two panes, the front one laid over the back one.
        <>
          <rect x="1.5" y="1.5" width="9" height="9" opacity="0.55" />
          <rect x="5.5" y="5.5" width="9" height="9" />
        </>
      )}
    </svg>
  )
}

function CoreEntry(props: { id: string; label: string; onClick: () => void }): React.JSX.Element {
  const key = chordOf(props.id)
  return (
    <button
      type="button"
      role="menuitem"
      className="menu-entry"
      onClick={props.onClick}
      aria-keyshortcuts={key ? ariaShortcut(key) : undefined}
    >
      <OpenIcon open="tab" />
      <span className="menu-label">{props.label}</span>
      {key && <Keys chord={key} />}
    </button>
  )
}

/**
 * The tab strip: select, close, a [+] menu (Claude / shell, then the user's command entries) and
 * a context menu for reordering (move left / right; no drag, by design).
 */
export function TabBar(props: {
  tabs: TabInfo[]
  activeId: string | null
  onSelect: (tabId: string) => void
  onClose: (tabId: string) => void
  onCreate: (kind: 'claude' | 'shell') => void
  /** A user entry of the [+] menu, by level and id: main looks its command up. */
  onCreateCommand: (level: TabCommandLevel, entryId: string) => void
  /** The user entries, as last read; null until the menu was first opened. */
  commands: TabCommandMenu | null
  /** The [+] menu is opening: read the entries again (they change in Settings). */
  onMenuOpen: () => void
  /** `delta` is -1 for left, +1 for right. */
  onMove: (tabId: string, delta: -1 | 1) => void
  /** Status of the window's Claude tabs by tab id (shell tabs have none). */
  sessions: ReadonlyMap<string, SessionDetail>
  onCancelQueued: (tabId: string, itemId: string) => void
}): React.JSX.Element {
  const { tabs, activeId } = props
  // Settings › Appearance and keys › Tabs; pushed by main, so every window's strip follows a pick.
  const { tabCloseSide } = usePrefs()
  const [createOpen, setCreateOpen] = useState(false)
  const [menu, setMenu] = useState<{ tabId: string; x: number; y: number } | null>(null)

  // Any click elsewhere or Escape closes whichever menu is open.
  const anyOpen = createOpen || menu !== null
  // A webview panel's native view would paint over the menu (shell-layers.ts).
  useShellLayer(anyOpen)
  useEffect(() => {
    if (!anyOpen) return
    const dismiss = (): void => {
      setCreateOpen(false)
      setMenu(null)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') dismiss()
    }
    window.addEventListener('click', dismiss)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', dismiss)
      window.removeEventListener('keydown', onKey)
    }
  }, [anyOpen])

  const menuIndex = menu ? tabs.findIndex((t) => t.id === menu.tabId) : -1

  return (
    <div className="tab-bar" data-close-side={tabCloseSide}>
      <div role="tablist" className="tab-list">
        {tabs.map((tab) => {
          const status = props.sessions.get(tab.id)
          // In the DOM where it shows (not CSS `order`), so Tab moves through a tab's buttons in
          // the order the eye reads them.
          const close = (
            <button
              type="button"
              className="tab-close"
              aria-label={`Close ${tabLabel(tab)}`}
              onClick={() => props.onClose(tab.id)}
            >
              <CloseGlyph size={12} />
            </button>
          )
          return (
          <div
            key={tab.id}
            className={`tab${tab.id === activeId ? ' active' : ''}${tab.exit ? ' exited' : ''}`}
          >
            {tabCloseSide === 'left' && close}
            <button
              type="button"
              role="tab"
              aria-selected={tab.id === activeId}
              className="tab-label"
              title={tab.kind === 'command' && tab.command !== undefined ? `${tab.command}\n${tab.cwd}` : tab.cwd}
              onClick={() => props.onSelect(tab.id)}
              onContextMenu={(e) => {
                e.preventDefault()
                setCreateOpen(false)
                setMenu({ tabId: tab.id, x: e.clientX, y: e.clientY })
              }}
            >
              {/* The mark before the label says the tab's kind: a Claude tab's status dot (with a
                  pulse while it works), a prompt for a shell, a window for a command entry. A
                  Claude tab with no status yet shows nothing there, as before. */}
              {status && <StatusDot status={status.status} {...(status.tool ? { tool: status.tool } : {})} />}
              {tab.kind === 'shell' && <ShellGlyph size={14} className="tab-kind" />}
              {tab.kind === 'command' && <CommandGlyph size={14} className="tab-kind" />}
              <span className="tab-text">
                {tabLabel(tab)}
                {tab.notStarted ? ' (not started)' : tab.exit ? ' (exited)' : ''}
              </span>
            </button>
            {status && (
              <QueuedChip
                queue={status.queue}
                onCancel={(itemId) => props.onCancelQueued(tab.id, itemId)}
              />
            )}
            {tabCloseSide === 'right' && close}
          </div>
          )
        })}
      </div>
      <div className="tab-new">
        <button
          type="button"
          aria-label="New tab"
          aria-haspopup="menu"
          aria-expanded={createOpen}
          onClick={(e) => {
            // Stop the click reaching the window listener, which would close the menu again.
            e.stopPropagation()
            setMenu(null)
            if (!createOpen) props.onMenuOpen()
            setCreateOpen(!createOpen)
          }}
        >
          <PlusGlyph size={15} />
        </button>
        {createOpen && (
          <div className="menu" role="menu">
            <CoreEntry id="tab.newClaude" label="Claude" onClick={() => props.onCreate('claude')} />
            <CoreEntry id="tab.newShell" label="Shell" onClick={() => props.onCreate('shell')} />
            {COMMAND_GROUPS.map(({ level, name }) => {
              const items = props.commands?.[level] ?? []
              if (items.length === 0) return null
              return (
                <div key={level} role="group" aria-label={name} className="menu-group">
                  <div role="separator" className="menu-separator" />
                  {/* The group's name shown too; hidden from assistive tech, which already
                      gets it from aria-label (it would be read twice). */}
                  <div className="menu-caption" aria-hidden="true">
                    {name}
                  </div>
                  {items.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      role="menuitem"
                      className="menu-entry"
                      data-level={level}
                      data-entry={item.id}
                      data-open={item.open}
                      onClick={() => props.onCreateCommand(level, item.id)}
                      aria-keyshortcuts={item.key ? ariaShortcut(item.key) : undefined}
                      aria-description={item.open === 'overlay' ? 'opens as an overlay' : undefined}
                    >
                      <OpenIcon open={item.open === 'overlay' ? 'overlay' : 'tab'} />
                      <span className="menu-label">{item.label}</span>
                      {/* Hidden from the accessible name (the label alone names the item);
                          aria-keyshortcuts carries the chord for assistive tech. */}
                      {item.key && <Keys chord={item.key} />}
                    </button>
                  ))}
                </div>
              )
            })}
          </div>
        )}
      </div>
      {menu && menuIndex >= 0 && (
        <div className="menu context-menu" role="menu" style={{ left: menu.x, top: menu.y }}>
          <button
            type="button"
            role="menuitem"
            disabled={menuIndex === 0}
            onClick={() => props.onMove(menu.tabId, -1)}
          >
            Move left
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={menuIndex === tabs.length - 1}
            onClick={() => props.onMove(menu.tabId, 1)}
          >
            Move right
          </button>
          <button type="button" role="menuitem" onClick={() => props.onClose(menu.tabId)}>
            Close
          </button>
        </div>
      )}
    </div>
  )
}
