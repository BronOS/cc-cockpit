import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { MAX_QUEUED_MESSAGES, READY_MESSAGE } from '../../sdk/panel-core'
import { isPlainObject } from '../../shared/guards'
import { MAX_OVERLAY_MESSAGE_LENGTH } from '../../shared/overlay-message'
import type { OverlayIntro } from '../../shared/overlay-envelope'
import { ipcErrorMessage } from '../ipc-error'
import { droppedEnvelope, isPageEnvelope, isPluginPage, overlayMessageOf, overlayResultOf, pageEnvelopeOf } from '../plugins/frame-messages'
import { frameTarget, PluginFrame } from '../plugins/PluginFrame'
import { isWebShell, viewAccessHint } from '../shell-kind'
import { shellPageUrl } from '../web/page-paths'
import { FrameLoads } from '../web/port-relay'
import { CopyLine, envelopeAnswerText, envelopeCallOf, type CopyLineState } from './overlay-copies'

/** Hands an inline page its MessagePort (transferred alongside); it has no SDK. */
const INLINE_PORT_MESSAGE = Object.freeze({ type: 'cc-overlay.port' })

/** What the page posts on its port to answer: `port.postMessage({ type: 'result', value })`. */
interface ResultMessage {
  type: 'result'
  value: unknown
}

function isResult(data: unknown): data is ResultMessage {
  return isPlainObject(data) && data.type === 'result'
}

/** The type of a message (an object with a string `type`), else undefined. */
function typeOf(data: unknown): unknown {
  return isPlainObject(data) ? data.type : undefined
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
  /**
   * The overlay is `perView` (OverlayInfo.perView): this view loads its own copy (CopyOverlay). Only a plugin's
   * page can be one (a plugin opens html overlays from its own files).
   */
  perView?: boolean
  /** perView: this view's copy's loader or final refusal changed (OverlayStack draws them). */
  onCopyState?: (state: CopyLineState) => void
  /** perView: main hid this view's copy; the overlay leaves this view's stack. */
  onHidden?: () => void
  /** perView: the intro this view's copies get before their port (overlayIntroOf: notes, Ask, page-started Discuss). */
  intro?: OverlayIntro
  /**
   * perView: the page asked for core's Discuss popover (`discuss.open`). Null when it opened (or was open already),
   * else the refusal the page is answered with. OverlayStack decides (the top overlay only, its gate).
   */
  onDiscussRequest?: () => string | null
}): React.JSX.Element {
  const { perView, onCopyState, onHidden, intro, onDiscussRequest, ...page } = props
  if (isPluginPage(props.src)) {
    if (perView === true) {
      return <CopyOverlay {...page} onCopyState={onCopyState} onHidden={onHidden} intro={intro} onDiscussRequest={onDiscussRequest} />
    }
    return <PluginOverlay {...page} />
  }
  return <InlineOverlay {...page} />
}

/**
 * This view's copy of a `perView` plugin overlay (docs/design-overlay-views.md §5; the lifecycle is CopyLine's,
 * overlay-copies.ts): every load of the frame connects a new copy, every page call names it, main's events for
 * this overlay are routed by copy, and `overlays.reload` loads the page again (a new frame element, so a new
 * load and a new copy). The page's `{ result }` follows this view's access (resultActionOf).
 *
 * Envelopes (shared/overlay-envelope.ts, spec-review S1, S12): the frame gets the intro before its port; a `$cc`
 * request on the port goes to CopyLine (notes and Ask become main's channels with this copy's id, `discuss.open` asks
 * OverlayStack for core's popover) and is answered on the port, never relayed as `overlays.message`; main's pushes
 * come marked (`envelope: true`) and an unmarked `$cc` is dropped (CopyLine.fromMain).
 */
function CopyOverlay(props: {
  overlayId: string
  title: string
  src: string
  onCopyState?: ((state: CopyLineState) => void) | undefined
  onHidden?: (() => void) | undefined
  intro?: OverlayIntro | undefined
  onDiscussRequest?: (() => string | null) | undefined
}): React.JSX.Element {
  const { overlayId } = props
  /** The frame element's generation: a reload asked by main is a new element (a new load, a new copy). */
  const [generation, setGeneration] = useState(0)
  /** One answer per overlay, whatever pages it loads. */
  const answered = useRef(false)
  const onCopyState = useRef(props.onCopyState)
  const onHidden = useRef(props.onHidden)
  const onDiscussRequest = useRef(props.onDiscussRequest)
  useEffect(() => {
    onCopyState.current = props.onCopyState
    onHidden.current = props.onHidden
    onDiscussRequest.current = props.onDiscussRequest
  })
  /**
   * This view's copy line (CopyLine), made in a layout effect so it exists before the frame's first load can fire
   * (the frame's own loads are set up in its layout effect, the load event comes later); read only from callbacks.
   */
  const line = useRef<CopyLine | null>(null)
  useLayoutEffect(() => {
    const current = new CopyLine({
      access: viewAccessHint(),
      ready: async () => window.cockpit.invoke('overlays.ready', { overlayId }),
      loaded: (copy) => {
        window.cockpit.invoke('overlays.loaded', { overlayId, copy }).catch(() => {})
      },
      message: (copy, message) => {
        window.cockpit.invoke('overlays.message', { overlayId, message, copy }).catch((err: unknown) => {
          console.warn('overlay message refused', err)
        })
      },
      release: (copy) => {
        window.cockpit.invoke('overlays.release', { overlayId, copy }).catch(() => {})
      },
      hide: () => {
        window.cockpit.invoke('overlays.release', { overlayId, hide: true }).catch((err: unknown) => console.warn('overlay hide failed', err))
      },
      close: () => {
        window.cockpit.invoke('overlays.close', { overlayId }).catch(() => {})
      },
      result: async (copy, value) => window.cockpit.invoke('overlays.result', { overlayId, value, copy }),
      // A page's envelope request (notes, Ask, Discuss): main's channel with this copy's id, built from checked fields
      // (envelopeCallOf), or core's Discuss popover (OverlayStack decides). A refusal rejects: the page gets ok: false.
      request: async (copy, envelope) => {
        const call = envelopeCallOf(overlayId, copy, envelope)
        if ('error' in call) throw new Error(call.error)
        if ('discuss' in call) {
          const refused = onDiscussRequest.current ? onDiscussRequest.current() : 'Discuss is not available here'
          if (refused !== null) throw new Error(refused)
          return null
        }
        try {
          // The call's channel and request are paired by EnvelopeCall; invoke's overloads cannot follow a union.
          return await (window.cockpit.invoke as (c: string, req: unknown) => Promise<unknown>)(call.channel, call.req)
        } catch (err) {
          throw new Error(ipcErrorMessage(err), { cause: err })
        }
      },
      reload: () => setGeneration((g) => g + 1),
      hidden: () => onHidden.current?.(),
      state: (state) => onCopyState.current?.(state),
      log: (message) => console.warn(message)
    })
    line.current = current
    // main's events for this overlay, routed by copy (a replaced copy's late ones reach nobody).
    const offMessage = window.cockpit.on('overlays.message', ({ overlayId: id, message, copy, envelope }) => {
      if (id !== overlayId || typeof message !== 'string' || typeof copy !== 'string') return
      // `envelope`: main's own push (notes, Ask), kept apart from the opener's posts down to the port (00 contract).
      if (envelope === true) current.fromMain(copy, message, true)
      else current.fromMain(copy, message)
    })
    const offHide = window.cockpit.on('overlays.hide', ({ overlayId: id, copy }) => {
      if (id === overlayId && typeof copy === 'string') current.mainHide(copy)
    })
    const offReload = window.cockpit.on('overlays.reload', ({ overlayId: id, copy }) => {
      if (id === overlayId && typeof copy === 'string') current.mainReload(copy)
    })
    return () => {
      offMessage()
      offHide()
      offReload()
      if (line.current === current) line.current = null
    }
  }, [overlayId])

  return (
    <PluginFrame
      key={generation}
      src={props.src}
      title={props.title}
      className="overlay-html"
      allowPopups
      localPort
      // Before the port on every load: which of notes, Ask and page-started Discuss this copy has (no intro: none).
      {...(props.intro ? { intro: props.intro } : {})}
      onPageMessage={(data) => {
        // `early`: said before the page had its port; CopyLine waits for the SDK's repeat at the port (that load's).
        if (typeOf(data) === READY_MESSAGE) line.current?.pageDrawn((data as { early?: unknown }).early === true)
      }}
      connect={(deliver) => {
        const ch = new MessageChannel()
        ch.port1.onmessage = (event: MessageEvent<unknown>) => {
          // An envelope (`$cc`) first: routed to its channel with the copy id, never relayed as overlays.message. Also
          // after the page answered: CopyLine refuses it at once then, where dropping it here left the page waiting
          // its 30 s for each request (review N7).
          const envelope = pageEnvelopeOf(event.data)
          if (envelope !== undefined) {
            if (isPageEnvelope(envelope)) line.current?.fromPageEnvelope(envelope)
            else {
              console.warn(`overlay envelope dropped: ${envelope.problem}`)
              // Readable enough to answer: the page's call fails now instead of at its timeout.
              if (envelope.id !== undefined) ch.port1.postMessage(envelopeAnswerText(envelope.id, { ok: false, error: envelope.problem }))
            }
            return
          }
          // Nothing more once the page answered: the overlay is closing with that answer.
          if (answered.current) return
          const answer = overlayResultOf(event.data)
          if (answer) {
            if (!line.current) return
            answered.current = true
            line.current.pageResult(answer.value, () => {
              answered.current = false
            })
            return
          }
          const text = overlayMessageOf(event.data)
          if (text === undefined) {
            console.warn(`overlay message dropped: not JSON, or over ${MAX_OVERLAY_MESSAGE_LENGTH} chars`)
            return
          }
          line.current?.fromPage(text)
        }
        deliver(ch.port2)
        // Asks main for this load's copy; the returned end lets it go (a plain release) when the load ends.
        // Envelopes (main's marked pushes, the shell's answers) and the opener's posts go down the same port: the page
        // SDK tells them apart by the top-level `$cc`, which only these carry (CopyLine.fromMain drops an unmarked one,
        // spec-review S12; handle.post and host-api refuse one).
        const end = line.current?.attach({ post: (text) => ch.port1.postMessage(text) })
        return () => {
          end?.()
          ch.port1.close()
        }
      }}
    />
  )
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
      window.cockpit.on('overlays.message', ({ overlayId: id, message, envelope }) => {
        if (id !== overlayId || typeof message !== 'string') return
        // No copy here, so no envelopes: notes and Ask are perView only (main never marks one for this overlay).
        if (droppedEnvelope(message, (m) => console.warn(m), envelope === true)) return
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
      // Made here at each served load, which is also when main hears `overlays.ready`.
      localPort
      onPageMessage={(data) => {
        if (typeOf(data) === READY_MESSAGE) pageDrawn(overlayId)
      }}
      connect={(deliver) => {
        const ch = new MessageChannel()
        ch.port1.onmessage = (event: MessageEvent<unknown>) => {
          // Nothing more once the page answered: the overlay is closing with that answer.
          if (answered.current) return
          // A `$cc` request from a page with no copy: notes, Ask and Discuss are perView only (spec-review S1).
          if (droppedEnvelope(event.data, (m) => console.warn(m))) return
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
  /** The frame element's generation (FrameLoads replaces it after a load the shell did not start). */
  const [frameKey, setFrameKey] = useState(0)
  const loads = useRef<FrameLoads | null>(null)
  /** One answer per overlay, whatever pages it loads. */
  const answered = useRef(false)
  // Read when the page talks, so the loads below are made once per mount.
  const id = useRef(overlayId)
  useEffect(() => {
    id.current = overlayId
  })

  // Loads judged as a plugin frame's (web/port-relay.ts): in the web shell a page that navigated
  // itself is replaced by a new frame on its path, and only a load the shell started is served.
  useLayoutEffect(() => {
    const current = new FrameLoads({
      guard: isWebShell(),
      portMessage: INLINE_PORT_MESSAGE,
      target: frameTarget(frame, setFrameKey),
      connect: (deliver) => {
        // A port per served load: the page that had the last one is gone with it (in the web shell a
        // page that navigated itself loads again on its path, in a new frame; it needs a live port
        // to say `ready` and to answer). The clean-up closes this one when that page goes.
        const ch = new MessageChannel()
        ch.port1.onmessage = (event: MessageEvent<unknown>) => {
          // An inline page has no SDK and no copy: an envelope from it is dropped (spec-review S1).
          if (droppedEnvelope(event.data, (m) => console.warn(m))) return
          // An inline page has no SDK: it says it has drawn with `{ type: 'ready' }` on its port.
          if (typeOf(event.data) === 'ready') {
            pageDrawn(id.current)
            return
          }
          if (answered.current || !isResult(event.data)) return
          answered.current = true
          sendResult(id.current, event.data.value, () => {
            answered.current = false
          })
        }
        // The port is the only thing sent, and only this frame's window receives it.
        deliver(ch.port2)
        // The page has loaded: main takes the loader away (a `ready: 'load'` overlay, the default).
        window.cockpit.invoke('overlays.ready', { overlayId: id.current }).catch(() => {})
        return () => ch.port1.close()
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

  return (
    <iframe
      key={frameKey}
      ref={frame}
      className="overlay-html"
      title={props.title}
      sandbox="allow-scripts"
      src={url}
      onLoad={() => loads.current?.loaded(frameKey)}
    />
  )
}
