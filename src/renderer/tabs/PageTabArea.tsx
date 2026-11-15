import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import type { TabInfo } from '../../shared/ipc'
import { PAGE_TAB_FRAME_NAME } from '../../shared/page-tabs'
import { forwardedChords, onKeyTable, runForwardedChord } from '../commands/keybindings'
import { requestPageTabPort } from '../plugins/panel-port-bus'
import { portMessage, themeMessage } from '../plugins/frame-messages'
import { currentPrefs, onPrefs } from '../prefs/prefs-store'
import { isWebShell } from '../shell-kind'
import { currentTheme, onTheme } from '../theme/theme-store'
import { shellPageUrl } from '../web/page-paths'
import type { PaneNode } from '../../shared/tab-groups'
import { frameBoxes } from './pane-layout'
import { sameFont } from './terminal-font'
import { PageFrames, ReadyReconnects, layerBox, pageTabEntries, type PageFrameElement } from './page-frames'

const isMac = navigator.platform.toLowerCase().includes('mac')

/**
 * The page's one layer of page tab frames (page-frames.ts): a fixed box appended to `<body>`, outside
 * the React root, so the web shell's remount (`<App key>`) leaves the frames and their pages alone.
 * The tab area's placeholder says where it goes (`place`). Made on first use, kept for the page's life.
 */
let layer: HTMLDivElement | undefined
let frames: PageFrames | undefined
/** Live frames take a new port at each web reconnect's `ready` (pool made or not: only live ones reconnect). */
const readies = new ReadyReconnects(() => frames?.reconnect())

/** Who opens Ask Claude's box for a page tab (TabsPane, which owns the modals); none: ignored. */
let discussHandler: ((tabId: string) => void) | undefined

/**
 * TabsPane opens the question box when the shown page tab asks (`ccPanel.tab.discuss()`); returns the
 * function that removes exactly this handler (a remount sets a new one first).
 */
export function setPageTabDiscussHandler(fn: (tabId: string) => void): () => void {
  discussHandler = fn
  return () => {
    if (discussHandler === fn) discussHandler = undefined
  }
}

/**
 * The web bridge's `ready` of generation `generation` (web/main.tsx, before the shell mounts): a
 * later one than the first is a web reconnect, and every live page tab frame takes a new port over
 * the new socket with no reload. The desktop shell never calls this.
 */
export function pageTabsReady(generation: number): void {
  readies.ready(generation)
}

function layerElement(): HTMLDivElement {
  if (layer) return layer
  const el = document.createElement('div')
  el.className = 'page-tab-layer'
  el.hidden = true
  document.body.appendChild(el)
  layer = el
  return el
}

/** An iframe in the layer, sandboxed as PluginFrame's (`allow-scripts` only, never same-origin). */
function createFrame(title: string): PageFrameElement {
  const iframe = document.createElement('iframe')
  iframe.className = 'page-tab-frame'
  iframe.title = title
  // How main tells a page tab's frame on the desktop (before-input-event, page-tab-keys.ts).
  iframe.name = PAGE_TAB_FRAME_NAME
  iframe.setAttribute('sandbox', 'allow-scripts')
  iframe.hidden = true
  layerElement().appendChild(iframe)
  const messageListeners: Array<(event: MessageEvent) => void> = []
  return {
    load: (url) => {
      iframe.src = url
    },
    // Pixels in the layer (position: absolute there, styles.css): set straight on the element,
    // never by moving it, which would reload its page.
    place: (box) => {
      if (box === null) {
        iframe.hidden = true
        return
      }
      iframe.style.left = `${box.left}px`
      iframe.style.top = `${box.top}px`
      iframe.style.width = `${box.width}px`
      iframe.style.height = `${box.height}px`
      iframe.hidden = false
    },
    post: (message, transfer) => {
      const target = iframe.contentWindow
      // '*': a sandboxed frame's origin is opaque, there is none to name; only this frame's window gets it.
      if (!target) return false
      target.postMessage(message, '*', transfer ?? [])
      return true
    },
    onLoad: (listener) => iframe.addEventListener('load', listener),
    remove: () => {
      for (const l of messageListeners.splice(0)) window.removeEventListener('message', l)
      iframe.remove()
    },
    focus: () => iframe.focus(),
    // Only this frame's own window (a sandboxed page's origin is opaque: the source is the check).
    onMessage: (listener) => {
      const l = (event: MessageEvent): void => {
        if (iframe.contentWindow !== null && event.source === iframe.contentWindow) listener(event.data)
      }
      messageListeners.push(l)
      window.addEventListener('message', l)
    },
    hasFocus: () => document.activeElement === iframe && document.hasFocus()
  }
}

/**
 * Observe what can move the placeholder: the root (the window resizing), the placeholder, each
 * ancestor below `<body>` and each ancestor's other children (never the layer itself, which the
 * measure resizes). Taken again on every render, as the tree changes.
 */
function observeAround(obs: ResizeObserver, node: Element): void {
  obs.disconnect()
  obs.observe(document.documentElement)
  for (let el: Element | null = node; el && el !== document.body; el = el.parentElement) {
    obs.observe(el)
    const parent: Element | null = el.parentElement
    if (parent) for (const sibling of Array.from(parent.children)) if (sibling !== el && sibling !== layer) obs.observe(sibling)
  }
}

/**
 * Whether a page tab of this view holds unsaved changes; false before the pool exists (nothing
 * mounted, nothing to lose). Read by the web shell's `beforeunload`, which must not make the pool.
 */
export function hasUnsavedPages(): boolean {
  return frames?.hasDirty() ?? false
}

/** The page's pool, made on first use with the DOM and IPC of this shell. */
export function pageFrames(): PageFrames {
  if (frames) return frames
  const pool = new PageFrames({
    createFrame,
    src: (tabId) => window.cockpit.invoke('pageTabs.src', { tabId }),
    pageUrl: shellPageUrl,
    connect: (tabId, deliver) => requestPageTabPort(tabId, deliver),
    disconnect: (tabId) => {
      window.cockpit.invoke('pageTabs.disconnect', { tabId }).catch((err: unknown) => console.warn(`pageTabs.disconnect ${tabId} failed`, err))
    },
    guard: isWebShell(),
    portMessage: portMessage(),
    reportDirty: (tabId, dirty) => {
      window.cockpit.invoke('pageTabs.dirty', { tabId, dirty }).catch((err: unknown) => console.warn(`pageTabs.dirty ${tabId} failed`, err))
    },
    // The web shell's pages forward the app's chords (no before-input-event there); the desktop lists none.
    keys: () => (isWebShell() ? forwardedChords() : undefined),
    chord: (chord) => {
      runForwardedChord(chord)
    },
    // A trusted key press (or click) in the frame activates its ancestors too (the HTML spec's user
    // activation), the shell included; a page's script cannot set it. It is transient (true for a
    // few seconds after any such input), so it says the person used the frame just now, not that
    // they pressed this chord. A browser without the API takes no forwarded chord (the safe side:
    // the chord is only lost inside page tabs).
    userActive: () => (navigator.userActivation as UserActivation | undefined)?.isActive === true,
    discuss: (tabId) => discussHandler?.(tabId),
    // Page tabs also get the terminal font (an editor draws code in it): frame-messages.ts terminalFontVars.
    theme: () => {
      const theme = currentTheme()
      return theme ? themeMessage(theme, isMac, currentPrefs().terminalFont) : undefined
    },
    log: (m) => console.warn(m)
  })
  onTheme((theme) => pool.themeChanged(themeMessage(theme, isMac, currentPrefs().terminalFont)))
  let font = currentPrefs().terminalFont
  onPrefs((prefs) => {
    if (sameFont(prefs.terminalFont, font)) return
    font = prefs.terminalFont
    const theme = currentTheme()
    if (theme) pool.themeChanged(themeMessage(theme, isMac, font))
  })
  if (isWebShell()) onKeyTable(() => pool.keysChanged())
  frames = pool
  return pool
}

const subscribeUnavailable = (listener: () => void): (() => void) => pageFrames().onUnavailable(listener)
const unavailableNow = (): ReadonlySet<string> => pageFrames().unavailable()

/**
 * The page tabs main named no page for in this view (`pageTabs.src` answered null: the plugin is off
 * or did not load), for SplitArea's "This page is not available" line in such a pane's body.
 */
export function usePageUnavailable(): ReadonlySet<string> {
  return useSyncExternalStore(subscribeUnavailable, unavailableNow)
}

/**
 * The split area's part for page tabs (in `.terminals`, rendered by SplitArea): a placeholder the
 * layer is laid over while any page pane shows in this view, and the pool told which tabs exist,
 * which are visible, which one is focused, where each frame goes, and when to hand frames a new port.
 * Unmounting (a web reconnect's remount) only hides the layer: the frames stay for the next area.
 * `listed`: the pane's first `tabs.list` answered; until then its empty list says nothing about
 * which tabs exist (page-frames.ts `sync`). `visible`, `zoomed`, `root` and `many` are SplitArea's
 * view of the group as drawn now (a live divider drag's sizes included), for `frameBoxes`; the
 * pixels come from the layer's own measure in the same layout effect, never from SplitArea's `area`
 * state, which a ResizeObserver sets one render late.
 */
export function PageTabArea(props: {
  tabs: readonly TabInfo[]
  listed: boolean
  activeId: string | null
  inert: boolean
  visible: readonly string[]
  zoomed: boolean
  root: PaneNode | undefined
  many: boolean
}): React.JSX.Element {
  const { tabs, listed, activeId, inert, visible, zoomed, root, many } = props
  const placeholder = useRef<HTMLDivElement>(null)
  const pageIds = new Set(tabs.filter((t) => t.kind === 'page').map((t) => t.id))
  const showsPage = visible.some((id) => pageIds.has(id))
  const activeIsPage = activeId !== null && pageIds.has(activeId)
  const visibleKey = visible.join(' ')

  // Passive effects, as before split panes: run as layout effects (in the commit that selects a new
  // file tab), hiding the focused frame of the tab left made the desktop window's document lose
  // focus for good (`document.hasFocus()` false with the new frame active, so its Ask Claude was
  // refused; editor.spec.ts Ctrl+L). The measure's `place` can run first in a commit: a frame that
  // just became visible keeps no box until this `show` re-applies the stored ones, a frame later.
  useEffect(() => {
    pageFrames().sync(listed ? pageTabEntries(tabs) : undefined)
  }, [tabs, listed])

  useEffect(() => {
    pageFrames().show(visibleKey === '' ? [] : visibleKey.split(' '), activeId)
  }, [activeId, visibleKey, tabs])

  // Selected: its page takes the keyboard, as a terminal tab's terminal does (TerminalView), unless
  // a dialog or screen is over it. A frame still loading gets it from focusActive later, if at all.
  const inertRef = useRef(inert)
  useEffect(() => {
    inertRef.current = inert
  })
  useEffect(() => {
    if (activeIsPage && activeId !== null && !inertRef.current) pageFrames().focus(activeId)
  }, [activeId, activeIsPage])

  useEffect(() => {
    // (A web reconnect is not seen here but at the bridge's `ready`, pageTabsReady.)
    // A host restart or a plugin reload: frames of those plugins take a new port, never a reload.
    const off = window.cockpit.on('panels.reload', ({ pluginIds }) => pageFrames().reconnect(pluginIds))
    return () => {
      off()
      if (layer) layer.hidden = true
    }
  }, [])

  // Inert with the zones (settings screen, an overlay, the close dialog): the layer is outside the
  // inert tree, so it is made inert itself, or Tab could walk into a page nobody sees.
  useEffect(() => {
    layerElement().inert = inert
  }, [inert])

  const measure = (): void => {
    const el = layerElement()
    const node = placeholder.current
    const box = layerBox(showsPage, node?.getBoundingClientRect())
    if (!box) {
      el.hidden = true
      return
    }
    el.style.left = `${box.left}px`
    el.style.top = `${box.top}px`
    el.style.width = `${box.width}px`
    el.style.height = `${box.height}px`
    el.hidden = false
    // The frames from the same measure as the layer, so the two never disagree for a frame.
    pageFrames().place(frameBoxes({ visible, zoomed, isPage: (id) => pageIds.has(id) }, root, { width: box.width, height: box.height }, many))
  }
  const latest = useRef(measure)
  const observer = useRef<ResizeObserver | null>(null)

  // Every render, before paint: a zone resizing or a new strip height moves the area. The observed
  // set is taken again too: the placeholder, each ancestor and each ancestor's children. The area
  // can move without resizing (a strip above it grows while a zone below shrinks by as much), and
  // whatever moves it in a flow, flex or grid layout resizes one of those, which a render of
  // another part of the tree does not tell this one.
  useLayoutEffect(() => {
    latest.current = measure
    measure()
    if (observer.current && placeholder.current) observeAround(observer.current, placeholder.current)
  })

  useEffect(() => {
    const remeasure = (): void => latest.current()
    const obs = new ResizeObserver(remeasure)
    observer.current = obs
    if (placeholder.current) observeAround(obs, placeholder.current)
    window.addEventListener('resize', remeasure)
    return () => {
      observer.current = null
      obs.disconnect()
      window.removeEventListener('resize', remeasure)
    }
  }, [])

  // Only a box to measure: the frame itself is in the layer, laid over it.
  return <div ref={placeholder} className="page-tab-area" hidden={!showsPage} aria-hidden="true" />
}
