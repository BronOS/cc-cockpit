import { useEffect, useRef } from 'react'
import { currentTheme, onTheme } from '../theme/theme-store'
import { portMessage, themeMessage } from './frame-messages'

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
 * SDK's `cc-plugin.slot`: the page is a slot of that type), and `onPageMessage` for what the page
 * posts to its parent (`ccPanel.slot.setHeight`). Only messages whose source is this frame's own
 * window reach it, so another frame cannot speak for this one.
 */
export function PluginFrame(props: {
  src: string
  title: string
  className: string
  connect: (deliver: (port: MessagePort) => void) => () => void
  intro?: object
  onPageMessage?: (data: unknown) => void
}): React.JSX.Element {
  const frame = useRef<HTMLIFrameElement>(null)
  const cleanup = useRef<(() => void) | undefined>(undefined)
  const connect = useRef(props.connect)
  const intro = useRef(props.intro)
  const onPageMessage = useRef(props.onPageMessage)
  useEffect(() => {
    connect.current = props.connect
    intro.current = props.intro
    onPageMessage.current = props.onPageMessage
  })

  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      const own = frame.current?.contentWindow
      if (!own || event.source !== own) return
      onPageMessage.current?.(event.data)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  useEffect(() => {
    // '*': a sandboxed frame's origin is opaque, there is no origin to name; only this frame's
    // window receives it.
    const offTheme = onTheme((theme) => frame.current?.contentWindow?.postMessage(themeMessage(theme, isMac), '*'))
    return () => {
      offTheme()
      cleanup.current?.()
      cleanup.current = undefined
    }
  }, [])

  const onLoad = (): void => {
    const target = frame.current?.contentWindow
    if (!target) return
    const theme = currentTheme()
    if (theme) target.postMessage(themeMessage(theme, isMac), '*')
    // A page that navigated itself (allowed in its sandbox) is a new page: it gets a new port.
    cleanup.current?.()
    cleanup.current = connect.current((port) => {
      // The frame may have loaded yet another page meanwhile; the port is for whatever is there.
      const now = frame.current?.contentWindow
      if (now) {
        if (intro.current) now.postMessage(intro.current, '*')
        now.postMessage(portMessage, '*', [port])
      }
      else port.close()
    })
  }

  return (
    <iframe
      ref={frame}
      className={props.className}
      title={props.title}
      sandbox="allow-scripts"
      src={props.src}
      onLoad={onLoad}
    />
  )
}
