// A webview panel in a server's browser view (design-web-browser.md §3, plan
// 20261111-streamed-webviews.md Task 6): main renders the page off-screen and streams JPEG frames
// over this view's socket (the bridge's `onWebviewFrame`); this draws the newest one on a canvas,
// letterboxed when another view owns the page's size, reports the panel's area and visibility
// (`webviews.place`, which makes this view a viewer: no report, no frames), offers "Fit to this
// screen" (`webviews.fit`), and shows the desktop's toolbar (webview-toolbar.tsx).
//
// Input (Task 7, design-web-browser.md §4.1): a focusable layer over the canvas takes the pointer
// (moves coalesced per animation frame, captured during a drag), the wheel (prevented, so the shell
// never scrolls) and, while focused, the keys, maps them to the page's CSS px (letterbox and frame
// scale undone; the letterbox bars send nothing) and sends them with `webviews.input`. The shell's
// command chords stay the shell's (the same `commandForEvent` the window's key handler and the
// terminals use); clipboard chords are never forwarded. The page's cursor comes back as
// `webviews.cursor` and is the layer's CSS cursor.
//
// Text (Task 8, §4.2): the keyboard focus is a hidden <textarea> in the layer, so the browser's
// IME, dead keys and AltGr work as in any text field. What it commits (`input` with insertText or
// insertReplacementText outside a composition, and `compositionend`) goes as
// `webviews.insertText`, and the textarea is emptied again. One printable ASCII key is not its: the
// key handler sends it as a key (main adds the char) and prevents it, so it is never typed twice
// (webviewKeyAction says which is which). Enter is a key ('\r' as its char), never the textarea's
// newline. A `paste` gives its text/plain, no clipboard permission needed (navigator.clipboard
// needs a secure context, which a LAN server over http is not). Copy: main pushes the page's
// selection after input that may change it (`webviews.selection`); the `copy` event sets the latest
// one, and `cut` does that and sends a Delete key. With nothing selected the browser's own copy
// runs (on an empty textarea: nothing), so the person's clipboard is left alone.
//
// Selects (Task 9, §4.4): the page does not paint a `<select>`'s popup, so main does not pass a press
// on one to the page and sends its options instead (`webviews.select`); this draws a dropdown over
// the select's place on the canvas (webview-select-menu.tsx) and answers `webviews.selectChoose`.
//
// The math, the key split and the outbox are DOM-free in webview-stream.ts and webview-select.ts
// (unit tested).

import { useCallback, useEffect, useRef, useState } from 'react'
import type { PanelInfo } from '../../shared/ipc'
import { WEBVIEW_CURSORS } from '../../shared/webview-keys'
import { commandForEvent } from '../commands/keybindings'
import { useWebviewPage, WebviewLoadError, WebviewToolbar } from '../zones/webview-toolbar'
import {
  boxToPage,
  textChunks,
  ClickCounter,
  FrameDecoder,
  framePageSize,
  inputModifiers,
  InputQueue,
  letterbox,
  PlaceReporter,
  pointerButton,
  sizeDiffers,
  webviewFrameSource,
  webviewKeyAction,
  wheelPixels,
  type DecodedFrame
} from './webview-stream'
import { pageRectToArea, placeMenu, type MenuPlace } from './webview-select'
import { WebviewSelectMenu, type SelectPopup } from './webview-select-menu'

/** A menu row's height and the rows a menu shows before it scrolls (its wanted height). */
const MENU_ROW_PX = 28
const MENU_ROWS = 12

export function WebviewCanvasPanel(props: { info: PanelInfo }): React.JSX.Element {
  const { panelKey, title, error } = props.info
  const page = useWebviewPage(panelKey)
  const hasPage = page.url !== ''
  // A page shown before and none now: its view went (a crash, the plugin stopped). Not on mount.
  const [hadPage, setHadPage] = useState(false)
  const [fit, setFit] = useState(false)
  const [drawn, setDrawn] = useState(false)
  const area = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const layer = useRef<HTMLDivElement>(null)
  const textbox = useRef<HTMLTextAreaElement>(null)
  // The frame on the canvas now (its header): input maps against the frame the person sees.
  const shown = useRef<DecodedFrame<ImageBitmap>['frame'] | undefined>(undefined)
  // The open select popup (at most one per panel: a new one replaces it, main closed the old id).
  const [menu, setMenu] = useState<{ popup: SelectPopup; place: MenuPlace }>()
  const menuId = useRef<string | undefined>(undefined)
  const answerMenu = useCallback(
    (id: string, index: number | null): void => {
      if (menuId.current !== id) return
      menuId.current = undefined
      setMenu(undefined)
      window.cockpit.invoke('webviews.selectChoose', { panelKey, id, index }).catch(() => {})
      // The keyboard goes back to the page.
      textbox.current?.focus({ preventScroll: true })
    },
    [panelKey]
  )

  // Derived during render (React's pattern for state that follows a prop), not in an effect.
  if (hasPage && !hadPage) setHadPage(true)

  // Placement reports: on mount, every resize of the area, and the page's visibility; visible:
  // false on unmount (main stops this view's frames).
  useEffect(() => {
    const node = area.current
    if (!node) return
    const reporter = new PlaceReporter(
      (r) => {
        window.cockpit.invoke('webviews.place', { panelKey, ...r }).catch(() => {})
      },
      { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) }
    )
    const measure = (): void => {
      const r = node.getBoundingClientRect()
      reporter.update(r.width, r.height, document.hidden)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    document.addEventListener('visibilitychange', measure)
    return () => {
      observer.disconnect()
      document.removeEventListener('visibilitychange', measure)
      reporter.dispose()
    }
  }, [panelKey])

  // Frames: decoded latest-only, drawn on the next animation frame (several decoded within one
  // frame draw once), and again when the area resizes (the letterbox moves).
  useEffect(() => {
    const node = canvas.current
    const box = area.current
    const source = webviewFrameSource()
    if (!node || !box || !source) return
    let current: DecodedFrame<ImageBitmap> | undefined
    let raf: number | undefined
    let fitShown = false
    const draw = (): void => {
      raf = undefined
      const ctx = node.getContext('2d')
      if (!ctx) return
      const rect = box.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      const w = Math.max(1, Math.round(rect.width * dpr))
      const h = Math.max(1, Math.round(rect.height * dpr))
      if (node.width !== w) node.width = w
      if (node.height !== h) node.height = h
      ctx.clearRect(0, 0, w, h)
      if (!current) return
      const lb = letterbox(rect.width, rect.height, current.frame)
      if (lb.width <= 0) return
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(current.bitmap, lb.x * dpr, lb.y * dpr, lb.width * dpr, lb.height * dpr)
      const differs = sizeDiffers(rect.width, rect.height, current.frame)
      if (differs !== fitShown) {
        fitShown = differs
        setFit(differs)
      }
    }
    const schedule = (): void => {
      if (raf === undefined) raf = requestAnimationFrame(draw)
    }
    const decoder = new FrameDecoder<ImageBitmap>(
      (jpeg) => createImageBitmap(new Blob([jpeg as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' })),
      (bitmap) => bitmap.close(),
      (decoded) => {
        current?.bitmap.close()
        current = decoded
        shown.current = decoded.frame
        schedule()
        setDrawn(true)
      }
    )
    const off = source(panelKey, (frame) => decoder.push(frame))
    const observer = new ResizeObserver(schedule)
    observer.observe(box)
    return () => {
      off()
      observer.disconnect()
      decoder.dispose()
      if (raf !== undefined) cancelAnimationFrame(raf)
      current?.bitmap.close()
      current = undefined
      shown.current = undefined
    }
  }, [panelKey])

  // Input: pointer, wheel, keys and text over the frame to the page (see the top of the file).
  useEffect(() => {
    const node = layer.current
    const text = textbox.current
    if (!node || !text) return
    const queue = new InputQueue(
      (events) => {
        window.cockpit.invoke('webviews.input', { panelKey, events }).catch(() => {})
      },
      { frame: (fn) => requestAnimationFrame(fn), cancel: (h) => cancelAnimationFrame(h as number) }
    )
    const clicks = new ClickCounter()
    // Buttons whose press went to the page (only their release goes too), and the last point sent.
    const pressed = new Set<'left' | 'middle' | 'right'>()
    let last: { x: number; y: number } | undefined
    // Keys whose key down went to the page, by `code`: their key up goes, with the down's key name.
    const held = new Map<string, string>()
    const toPage = (e: { clientX: number; clientY: number }, clamp: boolean): { x: number; y: number } | undefined => {
      const frame = shown.current
      if (!frame) return undefined
      const rect = node.getBoundingClientRect()
      const at = boxToPage(letterbox(rect.width, rect.height, frame), frame, e.clientX - rect.left, e.clientY - rect.top, clamp)
      if (at) last = at
      return at
    }
    const onPointerDown = (e: PointerEvent): void => {
      // Focus first (the keys follow the pointer, as in a page); prevented below, so no text of
      // the shell is selected and no compatibility mouse event focuses anything else. The textarea
      // moves under the pointer: an IME's candidate window opens at its caret, near where the
      // person clicked (an input field of the page, most likely), not in the panel's corner.
      const rect = node.getBoundingClientRect()
      text.style.left = `${Math.max(0, Math.min(rect.width - 1, e.clientX - rect.left))}px`
      text.style.top = `${Math.max(0, Math.min(rect.height - 1, e.clientY - rect.top))}px`
      text.focus({ preventScroll: true })
      e.preventDefault()
      const button = pointerButton(e.button)
      const at = button && toPage(e, false)
      if (!button || !at) return
      pressed.add(button)
      // Captured while a button is down: a drag that leaves the canvas still moves and releases.
      try {
        node.setPointerCapture(e.pointerId)
      } catch {
        // A pointer that is already gone: the release comes as pointercancel or never.
      }
      const clickCount = clicks.press(button, e.clientX, e.clientY, e.timeStamp)
      queue.push({ kind: 'pointer', type: 'down', ...at, button, clickCount, modifiers: inputModifiers(e) })
    }
    const onPointerMove = (e: PointerEvent): void => {
      const at = toPage(e, pressed.size > 0)
      if (at) queue.push({ kind: 'pointer', type: 'move', ...at, modifiers: inputModifiers(e) })
    }
    const onPointerUp = (e: PointerEvent): void => {
      const button = pointerButton(e.button)
      if (!button || !pressed.delete(button)) return
      const at = toPage(e, true) ?? last
      if (at) queue.push({ kind: 'pointer', type: 'up', ...at, button, clickCount: clicks.current(), modifiers: inputModifiers(e) })
    }
    // The page must not be left with a button or a key down that the browser will never release
    // here (a cancelled touch, the layer losing focus to the shell).
    const releaseButtons = (): void => {
      for (const button of pressed) if (last) queue.push({ kind: 'pointer', type: 'up', ...last, button, clickCount: 1, modifiers: [] })
      pressed.clear()
    }
    const releaseKeys = (): void => {
      for (const key of held.values()) queue.push({ kind: 'key', type: 'up', key, modifiers: [] })
      held.clear()
    }
    const onWheel = (e: WheelEvent): void => {
      // Always prevented over the layer: the wheel is the page's, never the shell's scroll.
      e.preventDefault()
      const frame = shown.current
      const at = toPage(e, false)
      if (!frame || !at) return
      const d = wheelPixels(e.deltaMode, e.deltaX, e.deltaY, framePageSize(frame).height)
      queue.push({ kind: 'wheel', ...at, ...d, modifiers: inputModifiers(e) })
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (webviewKeyAction(e, (k) => commandForEvent(k) !== undefined) !== 'forward') return
      e.preventDefault()
      held.set(e.code || e.key, e.key)
      queue.push({ kind: 'key', type: 'down', key: e.key, modifiers: inputModifiers(e) })
    }
    const onKeyUp = (e: KeyboardEvent): void => {
      const id = e.code || e.key
      const key = held.get(id)
      if (key === undefined) return
      held.delete(id)
      e.preventDefault()
      queue.push({ kind: 'key', type: 'up', key, modifiers: inputModifiers(e) })
    }
    const onBlur = (): void => {
      releaseKeys()
      queue.flush()
    }
    const onCancel = (): void => {
      releaseButtons()
      queue.flush()
    }
    const noMenu = (e: Event): void => e.preventDefault()

    // Text. Keys already queued go first, so the page gets them in the order they were typed.
    const sendText = (value: string): void => {
      if (value === '') return
      queue.flush()
      for (const chunk of textChunks(value)) {
        window.cockpit.invoke('webviews.insertText', { panelKey, text: chunk }).catch(() => {})
      }
    }
    let composing = false
    // Emptied after each commit: the textarea holds only what is being composed. Not inside a
    // composition (that would end it); after compositionend on the next task, as some IMEs start
    // the next composition from within that event.
    const clearText = (): void => {
      if (!composing) text.value = ''
    }
    const onInput = (e: Event): void => {
      const ie = e as InputEvent
      if (composing || ie.isComposing) return
      // insertText: typed (non-ASCII, AltGr); insertReplacementText: a spell checker's or a phone
      // keyboard's replacement. The rest (a line break, a deletion) is never the page's text: Enter
      // and Backspace go to the page as keys and are prevented here.
      if (ie.inputType === 'insertText' || ie.inputType === 'insertReplacementText') sendText(ie.data ?? text.value)
      clearText()
    }
    const onCompositionStart = (): void => {
      composing = true
    }
    const onCompositionEnd = (e: CompositionEvent): void => {
      composing = false
      sendText(e.data)
      setTimeout(clearText, 0)
    }
    const onPaste = (e: ClipboardEvent): void => {
      e.preventDefault()
      sendText(e.clipboardData?.getData('text/plain') ?? '')
    }
    // The page's selection as main last pushed it ('' for none).
    let selection = ''
    const offSelection = window.cockpit.on('webviews.selection', (p) => {
      if (p.panelKey === panelKey && typeof p.text === 'string') selection = p.text
    })
    const onCopy = (e: ClipboardEvent): boolean => {
      if (selection === '' || !e.clipboardData) return false
      e.clipboardData.setData('text/plain', selection)
      e.preventDefault()
      return true
    }
    const onCut = (e: ClipboardEvent): void => {
      if (!onCopy(e)) return
      queue.push({ kind: 'key', type: 'down', key: 'Delete', modifiers: [] })
      queue.push({ kind: 'key', type: 'up', key: 'Delete', modifiers: [] })
      queue.flush()
    }

    node.addEventListener('pointerdown', onPointerDown)
    node.addEventListener('pointermove', onPointerMove)
    node.addEventListener('pointerup', onPointerUp)
    node.addEventListener('pointercancel', onCancel)
    node.addEventListener('wheel', onWheel, { passive: false })
    text.addEventListener('keydown', onKeyDown)
    text.addEventListener('keyup', onKeyUp)
    text.addEventListener('blur', onBlur)
    text.addEventListener('input', onInput)
    text.addEventListener('compositionstart', onCompositionStart)
    text.addEventListener('compositionend', onCompositionEnd)
    text.addEventListener('paste', onPaste)
    text.addEventListener('copy', onCopy)
    text.addEventListener('cut', onCut)
    node.addEventListener('contextmenu', noMenu)
    // The page's cursor (main maps Chromium's names through a fixed table; only those are applied).
    node.style.cursor = ''
    const offCursor = window.cockpit.on('webviews.cursor', (p) => {
      if (p.panelKey === panelKey && WEBVIEW_CURSORS.has(p.cursor)) node.style.cursor = p.cursor
    })
    return () => {
      offCursor()
      offSelection()
      node.removeEventListener('pointerdown', onPointerDown)
      node.removeEventListener('pointermove', onPointerMove)
      node.removeEventListener('pointerup', onPointerUp)
      node.removeEventListener('pointercancel', onCancel)
      node.removeEventListener('wheel', onWheel)
      text.removeEventListener('keydown', onKeyDown)
      text.removeEventListener('keyup', onKeyUp)
      text.removeEventListener('blur', onBlur)
      text.removeEventListener('input', onInput)
      text.removeEventListener('compositionstart', onCompositionStart)
      text.removeEventListener('compositionend', onCompositionEnd)
      text.removeEventListener('paste', onPaste)
      text.removeEventListener('copy', onCopy)
      text.removeEventListener('cut', onCut)
      node.removeEventListener('contextmenu', noMenu)
      text.value = ''
      releaseButtons()
      releaseKeys()
      queue.dispose()
    }
  }, [panelKey])

  // Select popups from main, placed over the select as the person sees it on the canvas now.
  useEffect(() => {
    const off = window.cockpit.on('webviews.select', (p) => {
      if (p.panelKey !== panelKey || typeof p.id !== 'string' || !Array.isArray(p.options)) return
      const frame = shown.current
      const box = area.current?.getBoundingClientRect()
      const anchor = frame && box ? pageRectToArea(letterbox(box.width, box.height, frame), frame, p.rect) : undefined
      if (!box || !anchor) {
        // Nothing drawn to put it over: answered with no choice (main closes it).
        window.cockpit.invoke('webviews.selectChoose', { panelKey, id: p.id, index: null }).catch(() => {})
        return
      }
      menuId.current = p.id
      setMenu({ popup: p, place: placeMenu(anchor, box, Math.min(Math.max(1, p.options.length), MENU_ROWS) * MENU_ROW_PX + 12) })
    })
    return () => {
      off()
      menuId.current = undefined
      setMenu(undefined)
    }
  }, [panelKey])
  // The page navigated or went: its select is gone with it.
  useEffect(() => {
    const id = menuId.current
    if (id !== undefined) answerMenu(id, null)
  }, [page.url, hasPage, answerMenu])

  const fitButton = fit && hasPage && (
    <button
      type="button"
      className="webview-fit"
      title="Give the page this screen's size"
      onClick={() => {
        window.cockpit.invoke('webviews.fit', { panelKey }).catch(() => {})
      }}
    >
      Fit to this screen
    </button>
  )

  return (
    <div className="panel-body webview-panel webview-stream" data-panel-body={panelKey}>
      {error && (
        <p className="plugin-panel-error" role="status" title={error}>
          ⚠ {error}
        </p>
      )}
      <WebviewToolbar panelKey={panelKey} title={title} page={page} extra={fitButton} />
      <WebviewLoadError page={page} />
      <div ref={area} className="webview-canvas-area" data-webview={panelKey}>
        {/* No page (never one, or its view went): the last frame must not stay up as if it were live. */}
        <canvas
          ref={canvas}
          className="webview-canvas"
          hidden={!hasPage}
          data-drawn={drawn && hasPage ? 'true' : 'false'}
          aria-label={`${title} page`}
        />
        {/* Over the canvas: the pointer and the wheel go to the page; the keys and text through the
            hidden textarea, which has the focus while the page has the keyboard. */}
        <div ref={layer} className="webview-input" hidden={!hasPage}>
          <textarea
            ref={textbox}
            className="webview-text"
            aria-label={`${title} page input`}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            rows={1}
          />
        </div>
        {menu && hasPage && (
          <WebviewSelectMenu key={menu.popup.id} popup={menu.popup} place={menu.place} onDone={(index) => answerMenu(menu.popup.id, index)} />
        )}
        {!hasPage && (
          <p className="panel-placeholder webview-canvas-note" role="status">
            {hadPage ? `${title}: the page is gone` : `${title} shows nothing yet`}
          </p>
        )}
      </div>
    </div>
  )
}
