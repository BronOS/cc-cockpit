import { useEffect, useLayoutEffect, useRef } from 'react'
import type { TabInfo } from '../../shared/ipc'
import { requestPageTabPort } from '../plugins/panel-port-bus'
import { portMessage, themeMessage } from '../plugins/frame-messages'
import { isWebShell } from '../shell-kind'
import { currentTheme, onTheme } from '../theme/theme-store'
import { shellPageUrl } from '../web/page-paths'
import { PageFrames, type PageFrameElement, type PageTabEntry } from './page-frames'

const isMac = navigator.platform.toLowerCase().includes('mac')

/**
 * The page's one layer of page tab frames (page-frames.ts): a fixed box appended to `<body>`, outside
 * the React root, so the web shell's remount (`<App key>`) leaves the frames and their pages alone.
 * The tab area's placeholder says where it goes (`place`). Made on first use, kept for the page's life.
 */
let layer: HTMLDivElement | undefined
let frames: PageFrames | undefined
/** Tab areas mounted in this page's life: every one after the first is a web reconnect's remount. */
let mounts = 0

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

/** The page tabs of a tab list, as the pool takes them. */
export function pageTabEntries(tabs: readonly TabInfo[]): PageTabEntry[] {
  return tabs.flatMap((t) => (t.kind === 'page' && t.page ? [{ id: t.id, plugin: t.page.plugin, type: t.page.type, title: t.page.title }] : []))
}

/**
 * The tab area's part for page tabs (in `.terminals`, beside the terminal views): a placeholder the
 * layer is laid over while a page tab is the selected one, and the pool told which tabs exist,
 * which one shows, and when to hand frames a new port. Unmounting (a web reconnect's remount) only
 * hides the layer: the frames stay for the next tab area.
 */
export function PageTabArea(props: { tabs: readonly TabInfo[]; activeId: string | null; inert: boolean }): React.JSX.Element {
  const { tabs, activeId, inert } = props
  const placeholder = useRef<HTMLDivElement>(null)
  const active = tabs.find((t) => t.id === activeId)
  const showsPage = active?.kind === 'page'

  useEffect(() => {
    pageFrames().sync(pageTabEntries(tabs))
  }, [tabs])

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
    // A web reconnect remounted the shell: the old socket's ports are gone, every live frame takes
    // a new one with no reload (the desktop's tab area mounts once; React StrictMode's second dev
    // mount finds no frames yet).
    mounts += 1
    if (mounts > 1 && isWebShell()) pageFrames().reconnect()
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
    const r = node?.getBoundingClientRect()
    if (!showsPage || !r || r.width === 0 || r.height === 0) {
      el.hidden = true
      return
    }
    el.style.left = `${r.left}px`
    el.style.top = `${r.top}px`
    el.style.width = `${r.width}px`
    el.style.height = `${r.height}px`
    el.hidden = false
  }
  const latest = useRef(measure)

  // Every render, before paint: a zone resizing or a new strip height moves the area.
  useLayoutEffect(() => {
    latest.current = measure
    measure()
  })

  useEffect(() => {
    const remeasure = (): void => latest.current()
    const observer = new ResizeObserver(remeasure)
    if (placeholder.current) observer.observe(placeholder.current)
    // The window resizing can move the placeholder without resizing it.
    observer.observe(document.documentElement)
    window.addEventListener('resize', remeasure)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', remeasure)
    }
  }, [])

  // Only a box to measure: the frame itself is in the layer, laid over it.
  return <div ref={placeholder} className="page-tab-area" hidden={!showsPage} aria-hidden="true" />
}
