import { useEffect, useLayoutEffect, useRef } from 'react'
import type { TabInfo } from '../../shared/ipc'
import { requestPageTabPort } from '../plugins/panel-port-bus'
import { portMessage, themeMessage } from '../plugins/frame-messages'
import { isWebShell } from '../shell-kind'
import { currentTheme, onTheme } from '../theme/theme-store'
import { shellPageUrl } from '../web/page-paths'
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
  iframe.setAttribute('sandbox', 'allow-scripts')
  iframe.hidden = true
  layerElement().appendChild(iframe)
  return {
    load: (url) => {
      iframe.src = url
    },
    setHidden: (hidden) => {
      iframe.hidden = hidden
    },
    post: (message, transfer) => {
      const target = iframe.contentWindow
      // '*': a sandboxed frame's origin is opaque, there is none to name; only this frame's window gets it.
      if (!target) return false
      target.postMessage(message, '*', transfer ?? [])
      return true
    },
    onLoad: (listener) => iframe.addEventListener('load', listener),
    remove: () => iframe.remove(),
    focus: () => iframe.focus()
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
    theme: () => {
      const theme = currentTheme()
      return theme ? themeMessage(theme, isMac) : undefined
    },
    log: (m) => console.warn(m)
  })
  onTheme((theme) => pool.themeChanged(themeMessage(theme, isMac)))
  frames = pool
  return pool
}

/**
 * The tab area's part for page tabs (in `.terminals`, beside the terminal views): a placeholder the
 * layer is laid over while a page tab is the selected one, and the pool told which tabs exist,
 * which one shows, and when to hand frames a new port. Unmounting (a web reconnect's remount) only
 * hides the layer: the frames stay for the next tab area. `listed`: the pane's first `tabs.list`
 * answered; until then its empty list says nothing about which tabs exist (page-frames.ts `sync`).
 */
export function PageTabArea(props: { tabs: readonly TabInfo[]; listed: boolean; activeId: string | null; inert: boolean }): React.JSX.Element {
  const { tabs, listed, activeId, inert } = props
  const placeholder = useRef<HTMLDivElement>(null)
  const active = tabs.find((t) => t.id === activeId)
  const showsPage = active?.kind === 'page'

  useEffect(() => {
    pageFrames().sync(listed ? pageTabEntries(tabs) : undefined)
  }, [tabs, listed])

  useEffect(() => {
    pageFrames().show(showsPage && activeId !== null ? activeId : null)
  }, [activeId, showsPage, tabs])

  // Selected: its page takes the keyboard, as a terminal tab's terminal does (TerminalView), unless
  // a dialog or screen is over it. A frame still loading gets it from focusActive later, if at all.
  const inertRef = useRef(inert)
  useEffect(() => {
    inertRef.current = inert
  })
  useEffect(() => {
    if (showsPage && activeId !== null && !inertRef.current) pageFrames().focus(activeId)
  }, [activeId, showsPage])

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
