// The page side of edges-only scrolling (the rules and the sheets are in scroll-edges-core.ts):
// marks scroll containers, the element being scrolled and the one whose bar the pointer is near.
// Run once per document, by the panel SDK (panel.ts) in every plugin page and by the shell
// (renderer main.tsx, web/main.tsx). It imports only scroll-edges-core.ts, which main and the host
// never import, so it bundles into the SDK's classic script with no shared chunk.
//
// Cost, kept off the scroll path: while an element scrolls, one capturing `scroll` listener does a
// Map write (and one attribute write on the first event); the fade is CSS scroll-driven
// animations. Finding scroll containers reads `getComputedStyle` once per element, in one animation
// frame per batch of DOM changes: an added subtree is read whole, a `class` change re-reads the
// element and its subtree (a class can switch a descendant's overflow), a `style` change only the
// element. The pointer check runs at most once a frame and walks only the marked ancestors.
import {
  BASE_SCROLLBAR_CSS,
  EDGE_BOTTOM_ATTR,
  EDGE_CANVAS_VAR,
  EDGE_TIMELINES,
  EDGE_TOP_ATTR,
  NEAR_ATTR,
  SCROLLER_ATTR,
  SCROLLING_ATTR,
  SCROLL_EDGES_CSS,
  ScrollingMarks,
  classicBars,
  isClearColour,
  isScrollOverflow,
  nearScrollbar,
  scrollEdges
} from './scroll-edges-core'

const STARTED = Symbol.for('cc.scrollEdges')

/** Starts the script on `win`'s document; a second call on the same window does nothing. */
export function startScrollEdges(win: Window & typeof globalThis): void {
  const holder = win as unknown as Record<symbol, boolean>
  if (holder[STARTED]) return
  holder[STARTED] = true
  const doc = win.document
  const root = doc.documentElement
  // Firefox (no scroll timelines) and Safari (no `if()`), through web access: the script keeps the
  // edge attributes. The same two questions as the sheet's `@supports` (EDGE_TIMELINES).
  const timelines = typeof win.CSS?.supports === 'function' && EDGE_TIMELINES.every((c) => win.CSS.supports(`(${c})`))

  // ---- Which elements are scroll containers -------------------------------------------------
  const resized = timelines ? undefined : new win.ResizeObserver((entries) => entries.forEach((e) => edges(e.target)))

  function check(el: Element): void {
    if (el === root) return
    const style = win.getComputedStyle(el)
    const scroller = isScrollOverflow(style.overflowY) || isScrollOverflow(style.overflowX)
    if (scroller === el.hasAttribute(SCROLLER_ATTR)) return
    if (scroller) {
      el.setAttribute(SCROLLER_ATTR, '')
      resized?.observe(el)
      edges(el)
    } else {
      el.removeAttribute(SCROLLER_ATTR)
      resized?.unobserve(el)
    }
  }

  // A subtree root to read whole, or one element alone (a `style` change).
  const deep = new Set<Element>()
  const shallow = new Set<Element>()
  let scanFrame = 0
  function flush(): void {
    scanFrame = 0
    for (const el of deep) {
      if (!el.isConnected) continue
      check(el)
      const all = el.getElementsByTagName('*')
      for (let i = 0; i < all.length; i++) check(all[i]!)
    }
    for (const el of shallow) if (el.isConnected && !deep.has(el)) check(el)
    deep.clear()
    shallow.clear()
    canvas()
    if (!timelines) refreshAllEdges()
  }

  // The document scroller's fade is a veil in the page's own background (SCROLL_EDGES_CSS): the
  // root's colour, else the body's (which paints the canvas when the root has none). Read after
  // every batch of DOM changes, which includes the theme landing on the root's style; a page that
  // paints neither leaves the variable unset, and the sheet falls back to the theme's --cc-bg.
  let canvasColour: string | undefined
  function canvas(): void {
    let colour: string | undefined
    for (const el of [root, doc.body]) {
      const bg = el ? win.getComputedStyle(el).backgroundColor : ''
      if (!isClearColour(bg)) {
        colour = bg
        break
      }
    }
    if (colour === canvasColour) return
    canvasColour = colour
    // A write is a `style` mutation on the root, which queues one more scan; it finds the same colour.
    if (colour === undefined) root.style.removeProperty(EDGE_CANVAS_VAR)
    else root.style.setProperty(EDGE_CANVAS_VAR, colour)
  }
  function queue(el: Element, whole: boolean): void {
    ;(whole ? deep : shallow).add(el)
    if (!scanFrame) scanFrame = win.requestAnimationFrame(flush)
  }

  new win.MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'childList') {
        r.addedNodes.forEach((n) => {
          if (n.nodeType === 1) queue(n as Element, true)
        })
        // A list that grew or shrank changes its edges; with timelines CSS follows by itself.
        if (!timelines && !scanFrame) scanFrame = win.requestAnimationFrame(flush)
      } else if (r.target.nodeType === 1) {
        queue(r.target as Element, r.attributeName === 'class')
      }
    }
  }).observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] })
  queue(root, true)

  // ---- Edges without scroll timelines ------------------------------------------------------
  function edges(el: Element): void {
    if (timelines) return
    const box = el === root ? (doc.scrollingElement ?? root) : el
    const { top, bottom } = scrollEdges(box.scrollTop, box.scrollHeight, box.clientHeight)
    el.toggleAttribute(EDGE_TOP_ATTR, top)
    el.toggleAttribute(EDGE_BOTTOM_ATTR, bottom)
  }
  function refreshAllEdges(): void {
    edges(root)
    doc.querySelectorAll(`[${SCROLLER_ATTR}]`).forEach(edges)
  }
  if (!timelines) win.addEventListener('resize', () => edges(root))

  // ---- The element being scrolled -------------------------------------------------------------
  const marks = new ScrollingMarks<Element>()
  let timer: number | undefined
  function expire(): void {
    timer = undefined
    const now = win.performance.now()
    for (const el of marks.expire(now)) el.removeAttribute(SCROLLING_ATTR)
    const next = marks.next()
    if (next !== undefined) timer = win.setTimeout(expire, Math.max(0, next - now))
  }
  doc.addEventListener(
    'scroll',
    (event) => {
      const target = event.target
      const el = target === doc ? root : target instanceof win.Element ? target : undefined
      if (!el) return
      // A scroller the scan missed (its overflow came from a rule that matched later, :hover).
      if (el !== root && !el.hasAttribute(SCROLLER_ATTR)) check(el)
      if (marks.touch(el, win.performance.now())) el.setAttribute(SCROLLING_ATTR, '')
      if (timer === undefined) timer = win.setTimeout(expire, marks.next()! - win.performance.now())
      edges(el)
    },
    { capture: true, passive: true }
  )

  // ---- The bar the pointer is near ----------------------------------------------------------
  let near: Element | undefined
  let pointer: { x: number; y: number; target: EventTarget | null } | undefined
  let pointerFrame = 0
  function setNear(el: Element | undefined): void {
    if (el === near) return
    near?.removeAttribute(NEAR_ATTR)
    near = el
    near?.setAttribute(NEAR_ATTR, '')
  }
  function findNear(): Element | undefined {
    if (!pointer) return undefined
    const { x, y, target } = pointer
    // Innermost first: a list inside a scrolling page is the one whose edge the pointer means.
    let el = target instanceof win.Element ? target.closest(`[${SCROLLER_ATTR}]`) : null
    while (el) {
      const scrolls = { vertical: el.scrollHeight > el.clientHeight, horizontal: el.scrollWidth > el.clientWidth }
      if ((scrolls.vertical || scrolls.horizontal) && nearScrollbar(el.getBoundingClientRect(), x, y, scrolls)) return el
      el = el.parentElement?.closest(`[${SCROLLER_ATTR}]`) ?? null
    }
    // The viewport's own bar, which sits outside the root's client box.
    const page = doc.scrollingElement ?? root
    const scrolls = { vertical: page.scrollHeight > page.clientHeight, horizontal: page.scrollWidth > page.clientWidth }
    const box = { left: 0, top: 0, right: win.innerWidth, bottom: win.innerHeight }
    return nearScrollbar(box, x, y, scrolls) ? root : undefined
  }
  doc.addEventListener(
    'pointermove',
    (event) => {
      pointer = { x: event.clientX, y: event.clientY, target: event.target }
      if (!pointerFrame)
        pointerFrame = win.requestAnimationFrame(() => {
          pointerFrame = 0
          setNear(findNear())
        })
    },
    { capture: true, passive: true }
  )
  // The pointer left the page (or went into a frame, which runs its own copy of this script).
  doc.addEventListener('pointerout', (event) => {
    if (event.relatedTarget === null) {
      pointer = undefined
      setNear(undefined)
    }
  })
}

/** How often a pointer move may re-measure the bars (watchClassicBars). */
const POINTER_REMEASURE_MS = 2000

/**
 * Whether the bars are classic (macOS with a mouse connected and "Show scroll bars" on Automatic,
 * or on Always) or overlay bars: `onChange` runs at once and again on every change. The probe is a
 * scroller inside a shadow root, appended to the root for one read and removed: no page or SDK
 * sheet reaches it (a `::-webkit-scrollbar` rule would give it a width; BASE_SCROLLBAR_CSS itself
 * would turn its overlay bars classic and keep itself on), and its inline `auto`s stop the
 * inherited `scrollbar-color`. One read forces layout, so it runs only when the style can change:
 * window focus, resize, visibility, and a pointer move at most every two seconds (a mouse plugged in
 * while the window has the focus fires nothing else; its first move does). A probe with no layout (a
 * frame that is `display: none`) keeps the last answer.
 */
export function watchClassicBars(win: Window & typeof globalThis, onChange: (classic: boolean) => void): void {
  const doc = win.document
  let last: boolean | undefined
  let lastPointer = -Infinity
  function measure(): void {
    const host = doc.createElement('div')
    host.style.cssText = 'position:fixed;left:-1000px;top:-1000px;width:0;height:0;overflow:visible;pointer-events:none'
    const probe = doc.createElement('div')
    probe.style.cssText = 'width:100px;height:100px;overflow:scroll;scrollbar-width:auto;scrollbar-color:auto'
    host.attachShadow({ mode: 'closed' }).appendChild(probe)
    doc.documentElement.appendChild(host)
    const classic = classicBars(probe.offsetWidth, probe.clientWidth)
    host.remove()
    if (classic === undefined || classic === last) return
    last = classic
    onChange(classic)
  }
  measure()
  win.addEventListener('focus', measure)
  win.addEventListener('resize', measure)
  doc.addEventListener('visibilitychange', () => {
    if (doc.visibilityState === 'visible') measure()
  })
  doc.addEventListener(
    'pointermove',
    () => {
      const now = win.performance.now()
      if (now - lastPointer < POINTER_REMEASURE_MS) return
      lastPointer = now
      measure()
    },
    { capture: true, passive: true }
  )
}

/** The navigator says macOS (the shell's own test; plugin pages get the shell's answer as `mac`). */
export function isMac(win: Window): boolean {
  return win.navigator.platform.toLowerCase().includes('mac')
}

/**
 * The shell's start (renderer main.tsx and web/main.tsx), which has no panel SDK: adopts the fade
 * sheet and the bar sheet, then starts the script. On macOS the bar sheet is on only while the bars
 * are classic (watchClassicBars): overlay bars already hide at rest. Constructable sheets come
 * after the document's own, but their sub-layer and `:where()` keep every shell rule above them
 * (`scrollbar-width: none` on the tab strip, xterm's viewport, the tab strip's own sideways mask).
 */
export function startShellScrolling(win: Window & typeof globalThis): void {
  const [edges, bars] = [SCROLL_EDGES_CSS, BASE_SCROLLBAR_CSS].map((css) => {
    const sheet = new win.CSSStyleSheet()
    sheet.replaceSync(css)
    return sheet
  }) as [CSSStyleSheet, CSSStyleSheet]
  if (isMac(win)) {
    bars.disabled = true
    watchClassicBars(win, (classic) => {
      bars.disabled = !classic
    })
  }
  win.document.adoptedStyleSheets = [...win.document.adoptedStyleSheets, edges, bars]
  startScrollEdges(win)
}
