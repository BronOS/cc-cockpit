import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { isWebShell } from '../shell-kind'
import { currentTheme, onTheme } from '../theme/theme-store'
import { shellPageUrl } from '../web/page-paths'
import { FrameLoads, type FrameTarget } from '../web/port-relay'
import { KEYS_MESSAGE, TAB_KEY_MESSAGE } from '../../sdk/panel-core'
import { forwardedChords, onKeyTable, runForwardedChord } from '../commands/keybindings'
import { portMessage, themeMessage, withPortFlags } from './frame-messages'
import { isOneWayPort } from './panel-port-bus'

const isMac = navigator.platform.toLowerCase().includes('mac')

/**
 * The one loader of plugin pages, used by plugin panels (PluginPanel) and by html overlays a
 * plugin opened (HtmlOverlay): a `cc-plugin://` page in an iframe sandboxed with `allow-scripts`
 * only, never `allow-same-origin`, so it runs in an opaque origin with no way into this window, its
 * storage or the preload bridge; its CSP comes with the page from main (plugin-protocol.ts).
 *
 * On every load the page gets the app theme (and again on each change) and `connect` is asked for
 * its port: a panel's comes from main (its plugin's host on the other end), an overlay's is local.
 * `connect` returns the clean-up for that load. The page (src/sdk/panel.ts) takes both only from
 * this window, its parent.
 *
 * A slot frame (SlotFrame) also passes `intro`, posted on every load just before the port (the
 * SDK's `cc-plugin.slot`: the page is a slot of that type); so does a perView overlay copy (HtmlOverlay's
 * `cc-plugin.overlay`: which of notes, Ask and page-started Discuss it has, shared/overlay-envelope.ts; without
 * it the SDK leaves `ccPanel.notes` and `ccPanel.ask` undefined). And `onPageMessage` for what the page
 * posts to its parent (`ccPanel.slot.setHeight`, `setWidth`). Only messages whose source is this
 * frame's own window reach it, so another frame cannot speak for this one.
 *
 * In the web shell (design-web.md §5.3, §5.5) the page loads from its HTTP path (page-paths.ts), its
 * port from main comes through the socket relay (web/port-relay.ts), and only the loads this
 * component started are served: a page that navigated itself is replaced by a new frame element on
 * its own path (FrameLoads; `frameKey` is that element's generation). The port is asked for when the
 * load starts and posted in its load event, unless `localPort` (an overlay's port, made here at the
 * load). A relayed port is released when its page goes, since a browser port has no close event of
 * its own.
 *
 * `allowPopups` (plugin overlays only, HtmlOverlay) adds `allow-popups`, and nothing else: sandbox
 * flags only add up down the frame tree, so without it on this frame the reviewer's mail frame inside
 * it (`sandbox="allow-popups"`, no script) could not even ask for the popup that main turns into a
 * checked open in the system browser (main/windows/mail-frame-links.ts). Every popup is still denied
 * as a window by main (create-window.ts), so for any other page a popup does as little as before; no
 * `allow-popups-to-escape-sandbox`, and panels and slots (always on screen, where a page could catch
 * a click meant for the mail) stay without it.
 */
export function PluginFrame(props: {
  src: string
  title: string
  className: string
  connect: (deliver: (port: MessagePort) => void) => () => void
  intro?: object
  /**
   * What this frame's page posts to the shell; `from` is the event's source and this frame's window (the
   * same, checked here), for a filter that checks it again on its own (web/upload-request.ts).
   */
  onPageMessage?: (data: unknown, from: { source: MessageEventSource | null; frame: Window }) => void
  allowPopups?: boolean
  /** The port is made in the shell at the load (HtmlOverlay), not asked of main: asked for at the load. */
  localPort?: boolean
  /**
   * A panel or slot in the web shell: the app's chords typed in the page run the app's command (the
   * desktop's main does that before the frame sees the key, main/tabs/page-tab-keys.ts panelChord). The
   * shell lists the chords to the page, takes one back only while this frame holds the keyboard and the
   * browser says the person just gave real input, and runs it for the view's active tab.
   */
  forwardKeys?: boolean
}): React.JSX.Element {
  // The web shell loads the page over HTTP (page-paths.ts); undefined there: no path, an empty frame.
  const url = isWebShell() ? shellPageUrl(props.src) : props.src
  const frame = useRef<HTMLIFrameElement>(null)
  /** The frame element's generation: FrameLoads replaces the element (a new key) after a foreign load. */
  const [frameKey, setFrameKey] = useState(0)
  /** Which loads get the theme and a port (web/port-relay.ts), made before the first load can fire. */
  const loads = useRef<FrameLoads | null>(null)
  const connect = useRef(props.connect)
  const intro = useRef(props.intro)
  const onPageMessage = useRef(props.onPageMessage)
  /** Read once: the loads below are made once per mount. */
  const localPort = useRef(props.localPort === true)
  useEffect(() => {
    connect.current = props.connect
    intro.current = props.intro
    onPageMessage.current = props.onPageMessage
  })

  // Every load on the desktop, where main blocks a frame navigating; in the web shell only the loads
  // this component started. A layout effect: it runs in the commit that put the frame in the
  // document, before any load event of it can fire.
  useLayoutEffect(() => {
    const current = new FrameLoads({
      guard: isWebShell(),
      early: !localPort.current,
      // Says whether this shell is the web one: the page's `ccPanel.view.remote` (false on the desktop).
      portMessage: portMessage(),
      target: frameTarget(frame, setFrameKey),
      theme: () => {
        const theme = currentTheme()
        return theme ? themeMessage(theme, isMac) : undefined
      },
      intro: () => intro.current,
      connect: (deliver) => connect.current(deliver),
      log: (m) => console.warn(m)
    })
    loads.current = current
    return () => {
      current.dispose()
      if (loads.current === current) loads.current = null
    }
  }, [])

  // React sets `src` in the commit, before any load event can fire; this runs in the same commit,
  // so the load it starts counts as the shell's own (a changed `src` gets a new element as well).
  useLayoutEffect(() => {
    loads.current?.started(url)
  }, [url])

  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      const own = frame.current?.contentWindow
      if (!own || event.source !== own) return
      onPageMessage.current?.(event.data, { source: event.source, frame: own })
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  // The app's chords for a panel or slot page in the web shell: listed on every load and every new table.
  const forwardKeys = props.forwardKeys === true && isWebShell()
  const postKeys = (): void => {
    frame.current?.contentWindow?.postMessage({ type: KEYS_MESSAGE, keys: forwardedChords() }, '*')
  }
  useEffect(() => (forwardKeys ? onKeyTable(postKeys) : undefined), [forwardKeys])
  useEffect(() => {
    if (!forwardKeys) return
    const onKey = (event: MessageEvent): void => {
      const own = frame.current?.contentWindow
      if (!own || event.source !== own) return
      const { type, chord, code } = (event.data ?? {}) as { type?: unknown; chord?: unknown; code?: unknown }
      // Only a listed chord, only while this frame holds the keyboard, and only while the browser says the
      // person gave real input a moment ago (a page cannot run app commands from the background).
      if (type !== TAB_KEY_MESSAGE || typeof chord !== 'string' || document.activeElement !== frame.current) return
      if (!forwardedChords().includes(chord)) return
      if ((navigator.userActivation as { isActive?: boolean } | undefined)?.isActive !== true) return
      runForwardedChord(chord, undefined, typeof code === 'string' && code.length <= 32 ? code : undefined)
    }
    window.addEventListener('message', onKey)
    return () => window.removeEventListener('message', onKey)
  }, [forwardKeys])

  useEffect(() => onTheme((theme) => loads.current?.themeChanged(themeMessage(theme, isMac))), [])

  return (
    <iframe
      key={frameKey}
      ref={frame}
      className={props.className}
      title={props.title}
      sandbox={props.allowPopups === true ? 'allow-scripts allow-popups' : 'allow-scripts'}
      src={url}
      onLoad={() => {
        loads.current?.loaded(frameKey)
        if (forwardKeys) postKeys()
      }}
    />
  )
}

/** A frame element as FrameLoads drives it; `remount` sets the element's React key (a new element). */
export function frameTarget(frame: { readonly current: HTMLIFrameElement | null }, remount: (key: number) => void): FrameTarget {
  return {
    load: (to) => {
      if (frame.current) frame.current.src = to
    },
    remount,
    post: (message, transfer) => {
      const target = frame.current?.contentWindow
      // '*': a sandboxed frame's origin is opaque, there is no origin to name; only this frame's
      // window receives it.
      if (!target) return false
      // A port main marked one-way says so in its message (D-17), so the page may hide its controls.
      const port = transfer?.[0]
      target.postMessage(withPortFlags(message, port !== undefined && isOneWayPort(port)), '*', transfer ?? [])
      return true
    }
  }
}
