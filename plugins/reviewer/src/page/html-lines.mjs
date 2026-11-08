// An HTML file's Rendered view names source lines in its notes, as rendered markdown does
// (markdown.mjs data-md-lines). DOMParser keeps no source positions, so before parsing, every start
// tag of a block element gets `data-src-line="<key>:<offset of its '<'>"`, inserted right after the
// tag name: before the file's own attributes, so an attribute of the same name in the file comes
// second and the HTML parser drops it. Comments and the bodies of script, style, textarea and title
// are skipped (a `<p` inside them is not a tag). The scan is not a parser: a `<!--` inside an
// attribute value can hide a real tag from it, and the file could then put its own line number on
// that element. So the value starts with `key`, random per render, and the page counts only marks
// with its key. The sanitizer keeps the attribute as digits and one colon only.
// The page turns the offset into lines (blockLines): from the start tag's line to its closing tag's,
// or the line before the next block when that comes first (a `<p>` closed implicitly). Pure, so
// test/html-lines.test.js runs it under node (the selection helpers on a small fake DOM).

export const BLOCK_TAGS = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'hr', 'ul', 'ol', 'li', 'pre', 'blockquote', 'table', 'thead', 'tbody',
  'tr', 'th', 'td', 'div', 'details', 'summary', 'figure', 'figcaption', 'dl', 'dt', 'dd',
  // Unwrapped by the sanitizer (their children stay), so they mark nothing; listed for the parser's sake.
  'section', 'article', 'main', 'header', 'footer', 'nav', 'aside',
])

const SCAN = /<!--[\s\S]*?(?:-->|$)|<(script|style|textarea|title)\b[\s\S]*?(?:<\/\1\s*>|$)|<([a-zA-Z][a-zA-Z0-9-]*)/gi

/** The HTML with block start tags marked by their source offset, as `key:offset` (key: digits). */
export function markHtmlLines(src, key) {
  if (typeof src !== 'string') return ''
  let out = ''
  let last = 0
  SCAN.lastIndex = 0
  for (let m = SCAN.exec(src); m; m = SCAN.exec(src)) {
    const name = m[2]
    if (!name || !BLOCK_TAGS.has(name.toLowerCase())) continue
    const at = m.index + m[0].length
    out += `${src.slice(last, at)} data-src-line="${key}:${m.index}"`
    last = at
  }
  return out + src.slice(last)
}

/** The offset of a mark made with `key`, or null (no mark, or one the file wrote itself). */
export function markOffset(value, key) {
  const m = /^(\d{1,12}):(\d{1,8})$/.exec(value || '')
  return m && m[1] === String(key) ? Number(m[2]) : null
}

const VOID = new Set(['hr'])

/** The 1-based line of an offset. */
function lineAt(src, offset) {
  let n = 1
  for (let i = 0; i < offset && i < src.length; i++) if (src.charCodeAt(i) === 10) n++
  return n
}

/** The offset just past the closing tag of the start tag at `offset` (same name, nesting counted), or null. */
function closeOf(src, offset) {
  const name = (/^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(src.slice(offset, offset + 40)) || [])[1]
  if (!name) return null
  if (VOID.has(name.toLowerCase())) return offset + 1
  const re = new RegExp(`<!--[\\s\\S]*?(?:-->|$)|<(/?)${name}(?=[\\s/>])`, 'gi')
  re.lastIndex = offset
  let depth = 0
  for (let m = re.exec(src); m; m = re.exec(src)) {
    if (m[0].startsWith('<!--')) continue
    depth += m[1] ? -1 : 1
    if (depth === 0) return m.index + 1
  }
  return null
}

/**
 * The source lines of the blocks a selection starts and ends in (their marks' offsets), given the
 * offset of the next block after the end one that is not inside it (null: none follows):
 * { from, to }, to being the line of the end block's closing tag or the line before the next block,
 * whichever comes first, less blank lines at the end.
 */
export function blockLines(src, startOffset, endOffset, nextOffset) {
  const lines = src.split('\n')
  const from = lineAt(src, Math.min(startOffset, endOffset))
  const endStart = lineAt(src, endOffset)
  const close = closeOf(src, endOffset)
  let to = close !== null ? lineAt(src, close) : lines.length
  if (nextOffset !== null) to = Math.min(to, Math.max(endStart, lineAt(src, nextOffset) - 1))
  while (to > endStart && !(lines[to - 1] || '').trim()) to--
  return { from, to: Math.max(from, to) }
}

// ---- the lines of a selection ----
//
// Both read the block that holds each end of the selection (the DOM range's containers), walking up
// from it: the selected paragraph names its own lines even when its text is also elsewhere.

const elementOf = (node) => (node ? (node.nodeType === 1 ? node : node.parentElement) : null)

/**
 * A selection on a rendered markdown file: the source lines of the blocks it starts and ends in
 * (markdown.mjs data-md-lines), or null when neither end is inside a marked block of `body`.
 */
export function mdRangeLines(range, body) {
  const linesAt = (node) => {
    const e = elementOf(node)
    const b = e && e.closest('[data-md-lines]')
    if (!b || !body.contains(b)) return null
    const [from, to] = b.dataset.mdLines.split('-').map(Number)
    return { from, to }
  }
  const a = linesAt(range.startContainer)
  const b = linesAt(range.endContainer)
  if (!a && !b) return null
  return { from: Math.min((a || b).from, (b || a).from), to: Math.max((a || b).to, (b || a).to) }
}

/**
 * A selection on a rendered HTML file whose source is `src` and whose marks carry `key`: from the
 * block it starts in to the end of the block it ends in (blockLines), or null when neither end is
 * in a marked block of `body`.
 */
export function htmlRangeLines(range, body, src, key) {
  const at = (e) => markOffset(e.dataset.srcLine, key)
  const marked = [...body.querySelectorAll('[data-src-line]')].filter((e) => at(e) !== null)
  const blockAt = (node) => {
    for (let e = elementOf(node); e && body.contains(e); e = e.parentElement) if (marked.includes(e)) return e
    return null
  }
  const a = blockAt(range.startContainer)
  const b = blockAt(range.endContainer)
  if (!a && !b) return null
  const last = b || a
  const after = marked.slice(marked.indexOf(last) + 1).find((e) => !last.contains(e))
  return blockLines(src, at(a || b), at(last), after ? at(after) : null)
}
