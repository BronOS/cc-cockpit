import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { OverlayInfo } from '../../shared/ipc'
import { registerHandlers } from '../commands/keybindings'
import { GuestOverlayNote, HeldElsewhere } from '../plugins/HeldElsewhere'
import { usePrefs } from '../prefs/prefs-store'
import { currentGuest, holdsPage, isHiddenPage, isWebShell, viewAccessHint } from '../shell-kind'
import { shellAllows } from '../tabs/guest-shell'
import { gateTerminalIo } from '../tabs/terminal-access'
import { SessionRegistry, type TerminalIo } from '../tabs/terminal-session'
import { DiscussButton } from './DiscussPopover'
import type { DiscussTab } from './discuss-tabs'
import { domOrder, followOverlays, listOnce } from './follow-overlays'
import { HtmlOverlay } from './HtmlOverlay'
import { closeActionOf, htmlBodyOf, type CopyLineState } from './overlay-copies'
import { OverlayLoader, OverlayToolbar } from './OverlayToolbar'
import { urlViewBounds, type ToolbarEntry } from './overlay-toolbar'
import { TerminalOverlay } from './TerminalOverlay'
import { shellPageUrl } from '../web/page-paths'

/**
 * A terminal overlay's keystrokes, acks and size, through the overlay channels; a guest's gated like a
 * tab's (terminal-access.ts: a read guest never answers nor sizes an overlay, design-guests §8).
 */
function overlayIo(overlayId: string): TerminalIo {
  return gateTerminalIo(rawOverlayIo(overlayId), viewAccessHint())
}

function rawOverlayIo(overlayId: string): TerminalIo {
  return {
    input: (data) => {
      window.cockpit.invoke('overlays.input', { overlayId, data }).catch(() => {})
    },
    ack: (count) => {
      window.cockpit.invoke('overlays.ack', { overlayId, count }).catch(() => {})
    },
    resize: (cols, rows) => {
      window.cockpit.invoke('overlays.resize', { overlayId, cols, rows }).catch(() => {})
    }
  }
}

/**
 * ✕ or a close key (closeActionOf, D-2): a read guest's on a perView overlay hides its own copies
 * (`overlays.release { hide: true }`; main then drops the overlay from this guest's list); anyone else's closes it
 * for everyone, a write guest's included.
 */
function closeOverlay(overlay: Pick<OverlayInfo, 'id' | 'perView'>): void {
  const overlayId = overlay.id
  if (closeActionOf(overlay, viewAccessHint()) === 'hide') {
    window.cockpit.invoke('overlays.release', { overlayId, hide: true }).catch((err: unknown) => console.warn('overlay hide failed', err))
    return
  }
  window.cockpit.invoke('overlays.close', { overlayId }).catch(() => {})
}

/** "Take over": the html overlay's page moves to this view (main reloads it here, the holder shows the note). */
function takeOverlay(overlayId: string): void {
  window.cockpit.invoke('overlays.take', { overlayId }).catch((err: unknown) => console.warn('overlay take over failed', err))
}

/**
 * A toolbar button click: main checks it is a button it shows on this overlay now (not busy or
 * disabled) and routes it to the opener's `onButton` or the type button's plugin; the button shows
 * busy (main's next update) until that settles. Never to the overlay's page.
 */
function buttonClicked(overlayId: string, entry: ToolbarEntry): void {
  const click =
    entry.source === 'opener'
      ? { overlayId, source: 'opener' as const, buttonId: entry.button.id }
      : { overlayId, source: 'type' as const, pluginId: entry.pluginId, buttonId: entry.button.id }
  window.cockpit.invoke('overlays.button', click).catch(() => {})
}

/** The page's `overlays.list` (follow-overlays.ts listOnce: once per page load, every mount in the web shell). */
const listOverlays = listOnce(() => window.cockpit.invoke('overlays.list'), isWebShell)

/**
 * The window's overlay stack (design §4), drawn from main's list: each overlay covers the whole
 * window, the newest on top. main owns the stack and the results; this reports ✕ and the overlay
 * keys and lays out what main shows natively (a url overlay's page).
 *
 * Keys: `overlay.closeTop` (Cmd+Shift+W) is claimed while any overlay is open, `overlay.pop`
 * (Esc) only while the top one is not a terminal, so Esc otherwise reaches the program (or, with
 * no overlay, the tab's terminal). Keys typed inside a url page or an html iframe never reach
 * this page; main resolves those itself (overlay-manager.ts handleChord).
 */
export function OverlayStack(props: {
  /** The stack's size changed (0 when the last overlay closed). */
  onChange: (count: number) => void
  /** This window's Claude tabs, for Discuss with Claude's target list. */
  discussTabs: readonly DiscussTab[]
  /** The window's selected tab: Discuss preselects it when it is a Claude tab. */
  activeTabId: string | null
}): React.JSX.Element {
  const [{ stack: listed, order }, setView] = useState<{ stack: OverlayInfo[]; order: string[] }>({ stack: [], order: [] })
  /**
   * Overlays main hid in this view only (`overlays.hide` of this view's perView copy): off this view's stack until
   * main drops them. A guest's hide main also records and filters out of its list; an owner view's it does not
   * (D-1: every owner view gets every overlay), so this is the one record of it, kept for this mount.
   */
  const [hiddenHere, setHiddenHere] = useState<ReadonlySet<string>>(() => new Set())
  /** This view's copy of each perView overlay: its loader, or a final refusal of its connect (CopyLine). */
  const [copyStates, setCopyStates] = useState<Readonly<Record<string, CopyLineState>>>({})
  // What this view shows: main's stack less what was hidden here. Everything below (the top, the keys, the count
  // that makes the content below inert) reads this one.
  const stack = useMemo(() => (hiddenHere.size === 0 ? listed : listed.filter((o) => !hiddenHere.has(o.id))), [listed, hiddenHere])
  const { tabCloseSide } = usePrefs()
  /** The overlay whose toolbar "…" menu is open, if any: a url overlay hides its view meanwhile. */
  const [menuOpenFor, setMenuOpenFor] = useState<string | undefined>(undefined)
  /** The overlay whose Discuss popover is open, if any: the same reason. */
  const [discussOpenFor, setDiscussOpenFor] = useState<string | undefined>(undefined)
  const [terms] = useState(() => new SessionRegistry(overlayIo))
  /** Terminal overlays that have a session here, to dispose it once main drops the overlay. */
  const seen = useRef(new Set<string>())
  const onChange = useRef(props.onChange)
  useEffect(() => {
    onChange.current = props.onChange
  })

  useEffect(() => {
    const known = seen.current
    const offData = window.cockpit.on('overlays.data', ({ overlayId, data }) => {
      known.add(overlayId)
      terms.write(overlayId, data)
    })
    // An update that lands before the list answer wins over it (follow-overlays.ts).
    const offUpdated = followOverlays(
      { list: listOverlays, onUpdated: (listener) => window.cockpit.on('overlays.updated', listener) },
      (next) => {
        setView((prev) => ({ stack: next, order: domOrder(prev.order, next) }))
        // A hide or a copy's state outlives nothing: dropped once main's stack no longer has the overlay.
        const live = new Set(next.map((o) => o.id))
        setHiddenHere((prev) => ([...prev].every((id) => live.has(id)) ? prev : new Set([...prev].filter((id) => live.has(id)))))
        setCopyStates((prev) =>
          Object.keys(prev).every((id) => live.has(id)) ? prev : Object.fromEntries(Object.entries(prev).filter(([id]) => live.has(id)))
        )
      },
      (err) => console.warn('overlays.list failed', err)
    )
    return () => {
      offData()
      offUpdated()
      terms.disposeAll()
      known.clear()
    }
  }, [terms])

  useEffect(() => {
    const ids = new Set(stack.map((o) => o.id))
    // Includes overlays that came and went between two renders (a `true` that exited at once).
    for (const id of seen.current) {
      if (ids.has(id)) continue
      terms.dispose(id)
      seen.current.delete(id)
    }
    for (const o of stack) if (o.kind === 'terminal') seen.current.add(o.id)
  }, [stack, terms])

  // A layout effect, declared before the focus effect below: the owner makes what is under the
  // overlays inert from this count (TabsPane `covered`). A state update made in a layout effect
  // re-renders synchronously, before the browser paints or handles the next key. In a passive
  // effect the overlay took focus one render before the content below went inert, and a
  // Shift+Tab in that gap walked focus out to a button (or a terminal) under the overlay.
  useLayoutEffect(() => {
    onChange.current(stack.length)
  }, [stack])

  const top = stack.at(-1)
  const topId = top?.id
  const topKind = top?.kind
  const topPerView = top?.perView === true
  const topEl = useRef<HTMLDivElement>(null)
  // A layout effect: the handlers must change with the DOM, before the next key is handled. With
  // a passive effect a key pressed right after a new overlay appeared would still find the old
  // top's handler and close the overlay underneath.
  useLayoutEffect(() => {
    if (topId === undefined) return
    // An html overlay on top gets the keyboard on the overlay element, not in its frame: keys in
    // the frame never reach this page, so Esc there only works through main, and keys typed
    // behind the overlay must not reach the tab's terminal. The page gets keys once the user
    // clicks into it. (A terminal overlay focuses its xterm; main gives a url view native focus.)
    if (topKind === 'html') topEl.current?.focus()
    const close = (): void => closeOverlay({ id: topId, ...(topPerView ? { perView: true as const } : {}) })
    return registerHandlers(
      topKind === 'terminal'
        ? { 'overlay.closeTop': close }
        : { 'overlay.closeTop': close, 'overlay.pop': close }
    )
  }, [topId, topKind, topPerView])

  const guest = currentGuest()
  const bodyShell = {
    hiddenPage: isHiddenPage(),
    holds: holdsPage,
    hasPage: (src: string) => shellPageUrl(src) !== undefined,
    ...(guest ? { guest: { ownerName: guest.ownerName } } : {})
  }

  return (
    <>
      {order.map((id) => {
        // Drawn in a stable DOM order (domOrder); `i` is the overlay's place in main's stack.
        const i = stack.findIndex((o) => o.id === id)
        const overlay = stack[i]
        if (!overlay) return null
        const active = i === stack.length - 1
        // An html overlay (htmlBodyOf): a perView one loads its own copy here, with its own loader (copyStates);
        // any other's page lives in one view (design-web.md §5.4), the owner's others show where it is with Take
        // over and no loader (the loading is the holder's), a guest the note (§7).
        const copy = copyStates[overlay.id]
        const body = overlay.kind === 'html' ? htmlBodyOf(overlay, bodyShell, copy?.refused) : undefined
        const loading =
          body === undefined ? overlay.loading === true : body.kind === 'page' && (overlay.perView === true ? copy?.loading !== false : overlay.loading === true)
        return (
          <div
            key={overlay.id}
            ref={active ? topEl : undefined}
            tabIndex={-1}
            // Only the top overlay takes keys: Tab / Shift+Tab must not walk into one under it
            // (a terminal overlay's xterm textarea, a frame, a ✕) that the user cannot see.
            inert={!active}
            className="overlay"
            // Later overlays paint over earlier ones; all above the palette (z-index 100).
            style={{ zIndex: 200 + i }}
            role="dialog"
            aria-modal="true"
            aria-label={overlay.title}
            data-kind={overlay.kind}
            data-size={overlay.size}
          >
            <div className="overlay-frame">
            {/* The ✕ follows the tabs' close-side setting, so it sits where the user's hand already
                goes for a tab's ✕. */}
            <OverlayToolbar
              // A read guest's clicks would be refused (`overlays.button` is write-class): no buttons to press.
              overlay={shellAllows(viewAccessHint()).write ? overlay : { ...overlay, buttons: undefined, typeButtons: undefined }}
              closeSide={tabCloseSide}
              onClose={() => closeOverlay(overlay)}
              onButton={(entry) => buttonClicked(overlay.id, entry)}
              onMenuOpenChange={(open) =>
                setMenuOpenFor((cur) => (open ? overlay.id : cur === overlay.id ? undefined : cur))
              }
              // Discuss sends into a Claude tab: never from a read guest's view (D-22).
              discuss={
                overlay.discuss && shellAllows(viewAccessHint()).write && (
                  <DiscussButton
                    overlayId={overlay.id}
                    preferredTabId={overlay.discuss.tabId}
                    primary={overlay.discuss.primary === true}
                    tabs={props.discussTabs}
                    activeTabId={props.activeTabId}
                    onOpenChange={(open) =>
                      setDiscussOpenFor((cur) => (open ? overlay.id : cur === overlay.id ? undefined : cur))
                    }
                  />
                )
              }
            />
            <div className="overlay-body" data-loading={loading ? 'true' : undefined}>
              {overlay.kind === 'terminal' && (
                <TerminalOverlay overlayId={overlay.id} active={active} sessions={terms} />
              )}
              {overlay.kind === 'html' && body?.kind === 'page' && (
                <HtmlOverlay
                  overlayId={overlay.id}
                  title={overlay.title}
                  src={overlay.src}
                  perView={overlay.perView === true}
                  onCopyState={(state) => setCopyStates((prev) => ({ ...prev, [overlay.id]: state }))}
                  onHidden={() => setHiddenHere((prev) => new Set(prev).add(overlay.id))}
                />
              )}
              {body?.kind === 'held' && (
                <HeldElsewhere device={body.device} className="overlay-held-elsewhere" onTakeOver={() => takeOverlay(overlay.id)} />
              )}
              {body?.kind === 'note' && (
                // `overlays.take` is guest `no`: a guest is told where it is and why, with nothing to press.
                <GuestOverlayNote text={body.text} />
              )}
              {overlay.kind === 'url' && (
                <UrlBody
                  overlayId={overlay.id}
                  url={overlay.url}
                  menuOpen={menuOpenFor === overlay.id || discussOpenFor === overlay.id}
                />
              )}
              <OverlayLoader loading={loading} />
            </div>
            </div>
          </div>
        )
      })}
    </>
  )
}

/**
 * The area a url overlay's page fills. The page is a native view main lays over the window, so
 * this only reports where it is, again whenever it moves or resizes. While the toolbar's "…" menu
 * is open it reports zero bounds instead (urlViewBounds): the view would cover the menu.
 */
function UrlBody(props: { overlayId: string; url: string; menuOpen: boolean }): React.JSX.Element {
  // A native view of the host's window: a browser view has none to lay over this area (design-web.md §6.1).
  if (isWebShell()) {
    return (
      <p className="desktop-only-note" role="status" data-url={props.url}>
        This page is available on the desktop.
      </p>
    )
  }
  return <NativeUrlBody {...props} />
}

function NativeUrlBody(props: { overlayId: string; url: string; menuOpen: boolean }): React.JSX.Element {
  const { overlayId, menuOpen } = props
  const el = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const node = el.current
    if (!node) return
    const report = (): void => {
      const bounds = urlViewBounds(node.getBoundingClientRect(), menuOpen)
      window.cockpit.invoke('overlays.bounds', { overlayId, ...bounds }).catch(() => {})
    }
    // Also at once: opening or closing the menu changes what is reported, not the body's size.
    report()
    const observer = new ResizeObserver(report)
    observer.observe(node)
    // The size can stay the same while the position changes (the window resized around it).
    window.addEventListener('resize', report)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', report)
    }
  }, [overlayId, menuOpen])

  return <div ref={el} className="overlay-url" data-url={props.url} />
}
