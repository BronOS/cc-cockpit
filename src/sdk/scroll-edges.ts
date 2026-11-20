// The page side of edges-only scrolling (the rules and the sheets are in scroll-edges-core.ts):
// marks scroll containers, the element being scrolled and the one whose bar the pointer is near.
// Run once per document, by the panel SDK (panel.ts) in every plugin page and by the shell
// (renderer main.tsx, web/main.tsx). It imports only scroll-edges-core.ts, which main and the host
// never import, so it bundles into the SDK's classic script with no shared chunk.
//
// Cost, kept off the scroll path: while an element scrolls, one capturing `scroll` listener does a
// Map write (and one attribute write on the first event); the edges are CSS scroll-driven
// animations. Finding scroll containers reads `getComputedStyle` once per element, in one animation
// frame per batch of DOM changes: an added subtree is read whole, a `class` change re-reads the
// element and its subtree (a class can switch a descendant's overflow), a `style` change only the
// element. The pointer check runs at most once a frame and walks only the marked ancestors.
import {
  BASE_SCROLLBAR_CSS,
  EDGE_BOTTOM_ATTR,
  EDGE_TOP_ATTR,
  NEAR_ATTR,
  SCROLLER_ATTR,
  SCROLLING_ATTR,
  SCROLL_EDGES_CSS,
  ScrollingMarks,
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
  // Firefox (a web access browser) has no scroll timelines: the script keeps the edge attributes.
  const timelines = typeof win.CSS?.supports === 'function' && win.CSS.supports('animation-timeline: scroll()')

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
    if (!timelines) refreshAllEdges()
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

/**
 * The shell's start (renderer main.tsx and web/main.tsx), which has no panel SDK: adopts the edge
 * sheet, and the bar sheet off macOS (whose overlay bars already hide at rest), then starts the
 * script. Constructable sheets come after the document's own, but their sub-layer and `:where()`
 * keep every shell rule above them (`scrollbar-width: none` on the tab strip, xterm's viewport).
 */
export function startShellScrolling(win: Window & typeof globalThis): void {
  const mac = win.navigator.platform.toLowerCase().includes('mac')
  const made = (mac ? [SCROLL_EDGES_CSS] : [SCROLL_EDGES_CSS, BASE_SCROLLBAR_CSS]).map((css) => {
    const sheet = new win.CSSStyleSheet()
    sheet.replaceSync(css)
    return sheet
  })
  win.document.adoptedStyleSheets = [...win.document.adoptedStyleSheets, ...made]
  startScrollEdges(win)
}
