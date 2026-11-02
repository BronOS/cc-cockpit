import { useEffect, useRef } from 'react'
import { currentTheme, onTheme } from '../theme/theme-store'
import { portMessage, themeMessage } from './frame-messages'

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
 */
export function PluginFrame(props: {
  src: string
  title: string
  className: string
  connect: (deliver: (port: MessagePort) => void) => () => void
}): React.JSX.Element {
  const frame = useRef<HTMLIFrameElement>(null)
  const cleanup = useRef<(() => void) | undefined>(undefined)
  const connect = useRef(props.connect)
  useEffect(() => {
    connect.current = props.connect
  })

  useEffect(() => {
    // '*': a sandboxed frame's origin is opaque, there is no origin to name; only this frame's
    // window receives it.
    const offTheme = onTheme((theme) => frame.current?.contentWindow?.postMessage(themeMessage(theme), '*'))
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
    if (theme) target.postMessage(themeMessage(theme), '*')
    // A page that navigated itself (allowed in its sandbox) is a new page: it gets a new port.
    cleanup.current?.()
    cleanup.current = connect.current((port) => {
      // The frame may have loaded yet another page meanwhile; the port is for whatever is there.
      const now = frame.current?.contentWindow
      if (now) now.postMessage(portMessage, '*', [port])
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
