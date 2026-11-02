import { useEffect, useRef } from 'react'
import { isPluginPage, overlayResultOf } from '../plugins/frame-messages'
import { PluginFrame } from '../plugins/PluginFrame'

/** What the page posts on its port to answer: `port.postMessage({ type: 'result', value })`. */
interface ResultMessage {
  type: 'result'
  value: unknown
}

function isResult(data: unknown): data is ResultMessage {
  return typeof data === 'object' && data !== null && (data as { type?: unknown }).type === 'result'
}

/**
 * Relay a page's answer to main, which closes the overlay with it. main refuses a value that is not
 * JSON or too large by answering false (not by throwing): `onRefused` lets the page answer again,
 * or the overlay would stay open with no way to answer.
 */
function sendResult(overlayId: string, value: unknown, onRefused: () => void): void {
  window.cockpit
    .invoke('overlays.result', { overlayId, value })
    .then((accepted) => {
      if (accepted) return
      onRefused()
      console.warn('overlay result refused (not JSON, or too large)')
    })
    .catch((err: unknown) => {
      onRefused()
      console.warn('overlay result refused', err)
    })
}

/**
 * An html overlay, one of two kinds by `src`:
 * - an inline page (`ccc overlay --html`) that main serves from memory at `cc-overlay://<id>/` with
 *   its own CSP. Its one way out is a MessagePort handed over on load as `{ type: 'cc-overlay.port' }`:
 *   the first `{ type: 'result', value }` it posts there is relayed to main.
 * - a plugin's page (`ctx.overlay.open({ kind: 'html', file })`) at its `cc-plugin://` URL, loaded
 *   like a panel (PluginFrame: the plugin's CSP, the app theme, the panel SDK). Its port ends here,
 *   in the shell: `ccPanel.post({ result: value })` closes the overlay with that value, and
 *   `ctx.overlay.open` resolves with it. Nothing else it posts goes anywhere (the plugin has no
 *   handle on the overlay to talk to it; data it needs goes in the page itself).
 * Either runs in a sandboxed iframe (`allow-scripts` only, never `allow-same-origin`), so in an
 * opaque origin with no access to this window, its storage or the preload bridge.
 *
 * The frame does not take the keyboard by itself (OverlayStack focuses the overlay around it):
 * a page gets keys once the user clicks into it, and Esc then goes through main, because the
 * frame's key events never reach this page.
 */
export function HtmlOverlay(props: {
  overlayId: string
  title: string
  src: string
}): React.JSX.Element {
  if (isPluginPage(props.src)) return <PluginOverlay {...props} />
  return <InlineOverlay {...props} />
}

function PluginOverlay(props: { overlayId: string; title: string; src: string }): React.JSX.Element {
  const { overlayId } = props
  /** One answer per overlay, whatever pages it loads (a page may navigate itself). */
  const answered = useRef(false)
  return (
    <PluginFrame
      src={props.src}
      title={props.title}
      className="overlay-html"
      connect={(deliver) => {
        const ch = new MessageChannel()
        ch.port1.onmessage = (event: MessageEvent<unknown>) => {
          const answer = overlayResultOf(event.data)
          if (!answer || answered.current) return
          answered.current = true
          sendResult(overlayId, answer.value, () => {
            answered.current = false
          })
        }
        deliver(ch.port2)
        return () => ch.port1.close()
      }}
    />
  )
}

function InlineOverlay(props: { overlayId: string; title: string; src: string }): React.JSX.Element {
  const { overlayId } = props
  const frame = useRef<HTMLIFrameElement>(null)
  const channel = useRef<MessageChannel | null>(null)

  useEffect(() => () => channel.current?.port1.close(), [])

  const onLoad = (): void => {
    // One port per overlay: a page that navigates itself (allowed inside its sandbox) and loads
    // again does not get a second one.
    if (channel.current) return
    const target = frame.current?.contentWindow
    if (!target) return
    const ch = new MessageChannel()
    channel.current = ch
    let answered = false
    ch.port1.onmessage = (event: MessageEvent<unknown>) => {
      if (answered || !isResult(event.data)) return
      answered = true
      sendResult(overlayId, event.data.value, () => {
        answered = false
      })
    }
    // '*': a sandboxed frame's origin is opaque, so there is no origin to name. The port is the
    // only thing sent, and only this frame's window receives it.
    target.postMessage({ type: 'cc-overlay.port' }, '*', [ch.port2])
  }

  return (
    <iframe
      ref={frame}
      className="overlay-html"
      title={props.title}
      sandbox="allow-scripts"
      src={props.src}
      onLoad={onLoad}
    />
  )
}
