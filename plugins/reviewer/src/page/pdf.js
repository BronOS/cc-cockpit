// A PDF in the review overlay (sides.mode 'preview', kind 'pdf'): pdf.js renders each page to a
// canvas with its text layer on top, so text can be selected and a note taken on it (the note
// carries the page number and the quote, review.js addPdfNote). pdf.js itself is overlay/pdf.bundle.js
// (pdf-entry.mjs), loaded here on the first PDF only.
//
// Options, all for the sandboxed frame with an opaque origin and a script-src-self CSP:
//   useWasm: false        the JPX and colour-profile decoders are WASM (`'wasm-unsafe-eval'` is not
//                         in the plugin page CSP, and the CSP is not widened for this): a JPEG 2000
//                         picture inside a PDF is left blank; text and every other image show.
//   isEvalSupported: false  no `new Function` for fonts (the CSP refuses it anyway).
//   no cMapUrl / standardFontDataUrl  nothing is fetched from the opaque origin: the 14 standard
//                         fonts fall back to similar system fonts (useSystemFonts), and a CJK PDF
//                         without embedded CMaps may show boxes.
// Pages are laid out at once (their size, from each page's viewport) and drawn when they come near
// the visible area, so a 300-page PDF opens as fast as a 3-page one.

const SCRIPT = 'pdf.bundle.js'
const MAX_SCALE = 3
const MIN_SCALE = 0.5

let libPromise = null
/** pdf.js, loaded once by a script element (the CSP allows the plugin's own files). */
function loadLib() {
  if (globalThis.pdfjsLib) return Promise.resolve(globalThis.pdfjsLib)
  if (!libPromise) {
    libPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script')
      s.src = SCRIPT
      s.onload = () => (globalThis.pdfjsLib ? resolve(globalThis.pdfjsLib) : reject(new Error('pdf.js did not load')))
      s.onerror = () => reject(new Error('pdf.js did not load'))
      document.head.append(s)
    }).catch((e) => {
      libPromise = null
      throw e
    })
  }
  return libPromise
}

function bytesOf(b64) {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

const div = (cls) => {
  const d = document.createElement('div')
  d.className = cls
  return d
}

/**
 * Shows the PDF in `container` (emptied). Resolves with { pages } once the page frames are laid
 * out; rejects with a message for the person when pdf.js cannot open it (damaged, encrypted).
 * `onRendered(pageNumber)` is called as each page's text layer is in place.
 */
export async function showPdfIn(container, b64, { onRendered } = {}) {
  const lib = await loadLib()
  let doc
  try {
    doc = await lib.getDocument({
      data: bytesOf(b64),
      useWasm: false,
      isEvalSupported: false,
      useSystemFonts: true,
      enableXfa: false,
      stopAtErrors: false,
    }).promise
  } catch (e) {
    const name = e && e.name
    throw new Error(name === 'PasswordException' ? 'it is protected by a password' : name === 'InvalidPDFException' ? 'it is not a valid PDF' : `pdf.js: ${(e && e.message) || e}`)
  }
  const width = Math.max(200, container.clientWidth - 32)
  const list = div('pdf-pages')
  container.replaceChildren(list)
  const frames = []
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n)
    const base = page.getViewport({ scale: 1 })
    const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, width / base.width))
    const viewport = page.getViewport({ scale })
    const frame = div('pdf-page')
    frame.dataset.page = String(n)
    frame.style.width = `${Math.floor(viewport.width)}px`
    frame.style.height = `${Math.floor(viewport.height)}px`
    frame.style.setProperty('--scale-factor', String(scale))
    frame.style.setProperty('--total-scale-factor', String(scale))
    frame.setAttribute('aria-label', `Page ${n} of ${doc.numPages}`)
    list.append(frame)
    frames.push({ frame, page, viewport, drawn: false })
  }

  const draw = async (f) => {
    if (f.drawn) return
    f.drawn = true
    const ratio = window.devicePixelRatio || 1
    const canvas = document.createElement('canvas')
    canvas.width = Math.floor(f.viewport.width * ratio)
    canvas.height = Math.floor(f.viewport.height * ratio)
    canvas.style.width = `${Math.floor(f.viewport.width)}px`
    canvas.style.height = `${Math.floor(f.viewport.height)}px`
    const text = div('textLayer')
    f.frame.replaceChildren(canvas, text)
    try {
      await f.page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport: f.viewport, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : null }).promise
      await new lib.TextLayer({ textContentSource: f.page.streamTextContent(), container: text, viewport: f.viewport }).render()
      if (onRendered) onRendered(Number(f.frame.dataset.page))
    } catch (e) {
      f.frame.append(Object.assign(div('pdf-page-error'), { textContent: `Page ${f.frame.dataset.page} could not be drawn: ${(e && e.message) || e}` }))
    }
  }

  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue
        const f = frames[Number(e.target.dataset.page) - 1]
        if (f) draw(f)
      }
    },
    { root: container, rootMargin: '600px 0px' },
  )
  for (const f of frames) io.observe(f.frame)
  return { pages: doc.numPages }
}

/**
 * The selection inside one page's text: { page, quote, range }, or null (nothing selected, or it
 * spans pages: a note is about one place).
 */
export function pdfSelection(container) {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null
  const range = sel.getRangeAt(0)
  const pageOf = (node) => {
    const e = node && (node.nodeType === 1 ? node : node.parentElement)
    const p = e && e.closest('.pdf-page')
    return p && container.contains(p) ? p : null
  }
  const a = pageOf(range.startContainer)
  const b = pageOf(range.endContainer)
  if (!a || a !== b) return null
  const quote = sel.toString().replace(/\s+/g, ' ').trim()
  if (!quote) return null
  return { page: Number(a.dataset.page), quote, range }
}

/** Scrolls the page into view (its top), when it exists. */
export function scrollToPage(container, n) {
  const p = container.querySelector(`.pdf-page[data-page="${Number(n)}"]`)
  if (p) p.scrollIntoView({ block: 'start' })
}
