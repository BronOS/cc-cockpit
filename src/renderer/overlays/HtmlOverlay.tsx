import { useEffect, useLayoutEffect, useRef } from 'react'
import { MAX_QUEUED_MESSAGES, READY_MESSAGE } from '../../sdk/panel-core'
import { MAX_OVERLAY_MESSAGE_LENGTH } from '../../shared/overlay-message'
import { isPluginPage, overlayMessageOf, overlayResultOf } from '../plugins/frame-messages'
import { frameTarget, PluginFrame } from '../plugins/PluginFrame'
import { isWebShell } from '../shell-kind'
import { shellPageUrl } from '../web/page-paths'
import { FrameLoads } from '../web/port-relay'

/** Hands an inline page its MessagePort (transferred alongside); it has no SDK. */
const INLINE_PORT_MESSAGE = Object.freeze({ type: 'cc-overlay.port' })

/** What the page posts on its port to answer: `port.postMessage({ type: 'result', value })`. */
interface ResultMessage {
  type: 'result'
  value: unknown
}

function isResult(data: unknown): data is ResultMessage {
  return typeof data === 'object' && data !== null && (data as { type?: unknown }).type === 'result'
}

/** The type of a message (an object with a string `type`), else undefined. */
function typeOf(data: unknown): unknown {
  return typeof data === 'object' && data !== null ? (data as { type?: unknown }).type : undefined
}

/** The page has drawn (`ccPanel.ready()`, or `{ type: 'ready' }` on an inline page's port): its loader goes. */
function pageDrawn(overlayId: string): void {
  window.cockpit.invoke('overlays.loaded', { overlayId }).catch(() => {})
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
 *   `ctx.overlay.open` resolves with it. Anything else it posts is relayed to main
 *   (`overlays.message`), which hands it to the plugin that opened the overlay, if it opened it with
 *   `ctx.overlay.start`; what that plugin posts comes back as the `overlays.message` event and goes
 *   down the port. main holds those posts until this page's port is up (`overlays.ready`).
 *   `ccPanel.ready()` reaches this window as `cc-plugin.ready` (not on the port, which is the
 *   opener's line) and tells main the page has drawn (`overlays.loaded`): the loader of a
 *   `ready: 'manual'` overlay goes then; a `load` one's goes at `overlays.ready`.
 * Either runs in a sandboxed iframe (`allow-scripts`, never `allow-same-origin`; a plugin's page also
 * `allow-popups`, which main denies as windows, see PluginFrame), so in an opaque origin with no
 * access to this window, its storage or the preload bridge.
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
  /** The current page's port, null between pages. */
  const port = useRef<MessagePort | null>(null)
  /**
   * The opener's posts that arrived between two pages (the page navigated itself: main still counts
   * it as loaded). Bounded like the page SDK's own queue.
   */
  const pending = useRef<string[]>([])

  useEffect(
    () =>
      window.cockpit.on('overlays.message', ({ overlayId: id, message }) => {
        if (id !== overlayId || typeof message !== 'string') return
        if (port.current) port.current.postMessage(message)
        else if (pending.current.length < MAX_QUEUED_MESSAGES) pending.current.push(message)
        else console.warn('overlay message dropped: the page is not connected and the queue is full')
      }),
    [overlayId]
  )

  return (
    <PluginFrame
      src={props.src}
      title={props.title}
      className="overlay-html"
      // For a no-script frame inside the page (the reviewer's Original view of a mail): its link
      // clicks are popup requests main checks and opens in the system browser (PluginFrame).
      allowPopups
      onPageMessage={(data) => {
        if (typeOf(data) === READY_MESSAGE) pageDrawn(overlayId)
      }}
      connect={(deliver) => {
        const ch = new MessageChannel()
        ch.port1.onmessage = (event: MessageEvent<unknown>) => {
          // Nothing more once the page answered: the overlay is closing with that answer.
          if (answered.current) return
          const answer = overlayResultOf(event.data)
          if (answer) {
            answered.current = true
            sendResult(overlayId, answer.value, () => {
              answered.current = false
            })
            return
          }
          const text = overlayMessageOf(event.data)
          if (text === undefined) {
            console.warn(`overlay message dropped: not JSON, or over ${MAX_OVERLAY_MESSAGE_LENGTH} chars`)
            return
          }
          window.cockpit.invoke('overlays.message', { overlayId, message: text }).catch((err: unknown) => {
            console.warn('overlay message refused', err)
          })
        }
        deliver(ch.port2)
        port.current = ch.port1
        // Posts sent before this port was up (a page navigating itself), then main's queue.
        for (const message of pending.current.splice(0)) ch.port1.postMessage(message)
        window.cockpit.invoke('overlays.ready', { overlayId }).catch(() => {})
        return () => {
          if (port.current === ch.port1) port.current = null
          ch.port1.close()
        }
      }}
    />
  )
}

function InlineOverlay(props: { overlayId: string; title: string; src: string }): React.JSX.Element {
  const { overlayId } = props
  // The web shell loads it from the device's overlay path (page-paths.ts); none: an empty frame.
  const url = isWebShell() ? shellPageUrl(props.src) : props.src
  const frame = useRef<HTMLIFrameElement>(null)
  const channel = useRef<MessageChannel | null>(null)
  const loads = useRef<FrameLoads | null>(null)
  // Read when the page talks, so the loads below are made once per mount.
  const id = useRef(overlayId)
  useEffect(() => {
    id.current = overlayId
  })

  // Loads judged as a plugin frame's (web/port-relay.ts): in the web shell a page that navigated
  // itself is put back on its path, and only a load the shell started is served.
  useLayoutEffect(() => {
    const current = new FrameLoads({
      guard: isWebShell(),
      portMessage: INLINE_PORT_MESSAGE,
      target: frameTarget(frame),
      connect: (deliver) => {
        // One port per overlay: a page that loads again (it navigated itself, allowed inside its
        // sandbox) does not get a second one.
        if (channel.current) return () => {}
        const ch = new MessageChannel()
        channel.current = ch
        let answered = false
        ch.port1.onmessage = (event: MessageEvent<unknown>) => {
          // An inline page has no SDK: it says it has drawn with `{ type: 'ready' }` on its port.
          if (typeOf(event.data) === 'ready') {
            pageDrawn(id.current)
            return
          }
          if (answered || !isResult(event.data)) return
          answered = true
          sendResult(id.current, event.data.value, () => {
            answered = false
          })
        }
        // The port is the only thing sent, and only this frame's window receives it.
        deliver(ch.port2)
        // The page has loaded: main takes the loader away (a `ready: 'load'` overlay, the default).
        window.cockpit.invoke('overlays.ready', { overlayId: id.current }).catch(() => {})
        return () => {}
      }
    })
    loads.current = current
    return () => {
      current.dispose()
      if (loads.current === current) loads.current = null
    }
  }, [])

  useLayoutEffect(() => {
    loads.current?.started(url)
  }, [url])

  useEffect(() => () => channel.current?.port1.close(), [])

  return (
    <iframe
      ref={frame}
      className="overlay-html"
      title={props.title}
      sandbox="allow-scripts"
      src={url}
      onLoad={() => loads.current?.loaded()}
    />
  )
}
