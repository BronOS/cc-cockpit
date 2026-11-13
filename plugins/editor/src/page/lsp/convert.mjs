// Conversions between CodeMirror and the host's LSP answers, with no DOM and no CodeMirror import
// (node:test drives them with a small document of CodeMirror's shape). A "doc" here is anything
// with CodeMirror Text's `lines`, `length`, `line(n)` and `lineAt(pos)` (1-based lines, `from`/`to`
// offsets); positions are LSP's `{ line, character }` in UTF-16 units, as JS strings count them.

// Line breaks. The file tab splits its document on `\n` alone (line-breaks.mjs: a `\r` stays in the
// text so a mixed or CR file is kept exactly), but LSP, and the host's edits.js offsetAt with it,
// count `\r\n`, a lone `\r` and `\n` as breaks. So a CodeMirror line may hold several LSP lines
// (split at each lone `\r`), and a CodeMirror line ending in the `\r` of a CRLF ends, for LSP, before
// that `\r`. Counting only CodeMirror's lines put every position after a lone `\r` on the wrong LSP
// line: an edit meant for `bb` in `a\rbb\ncc` replaced `cc`.

/** doc -> the sorted offsets of its lone `\r` breaks (a `\r` not followed by `\n`). CodeMirror Text is immutable, so a doc's list never changes. */
const loneCrCache = new WeakMap()

function loneCrs(doc) {
  let list = loneCrCache.get(doc)
  if (list) return list
  list = []
  const text = doc.toString()
  for (let i = text.indexOf('\r'); i !== -1; i = text.indexOf('\r', i + 1)) if (text.charCodeAt(i + 1) !== 10) list.push(i)
  loneCrCache.set(doc, list)
  return list
}

/** How many of the sorted `list` are below `at`. */
function countBelow(list, at) {
  let lo = 0
  let hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (list[mid] < at) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** The LSP line CodeMirror line `n` (1-based) starts. */
const lspLineOfCm = (doc, crs, n) => n - 1 + countBelow(crs, doc.line(n).from)

/** The offset of an LSP position in `doc`: a character past its line's end is the end (before its break), a line past the last is the document's end. */
export function offsetOf(doc, pos) {
  if (!pos || !Number.isInteger(pos.line) || pos.line < 0) return 0
  const crs = loneCrs(doc)
  // The last CodeMirror line that starts at or before LSP line pos.line (line 1 starts LSP line 0).
  let lo = 1
  let hi = doc.lines
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (lspLineOfCm(doc, crs, mid) <= pos.line) lo = mid
    else hi = mid - 1
  }
  const l = doc.line(lo)
  const first = countBelow(crs, l.from)
  const inLine = countBelow(crs, l.to) - first // the lone `\r`s inside this line
  const k = pos.line - (lo - 1 + first) // the LSP line's index within this CodeMirror line
  if (k > inLine) return doc.length
  const from = k === 0 ? l.from : crs[first + k - 1] + 1
  // Its end: the next lone `\r`, else the line's end, before a CRLF's `\r` (never between it and the `\n`).
  let end = k < inLine ? crs[first + k] : l.to
  if (k === inLine && lo < doc.lines && end > from && doc.sliceString(end - 1, end) === '\r') end--
  const ch = Number.isInteger(pos.character) && pos.character > 0 ? pos.character : 0
  return Math.min(from + ch, end)
}

/** The LSP position of offset `at` in `doc`. */
export function positionOf(doc, at) {
  at = Math.max(0, Math.min(at, doc.length))
  const crs = loneCrs(doc)
  const l = doc.lineAt(at)
  const below = countBelow(crs, at) // the lone `\r`s before `at`: each one a break
  const start = below > 0 && crs[below - 1] >= l.from ? crs[below - 1] + 1 : l.from
  return { line: l.number - 1 + below, character: at - start }
}

/** Whether offset `at` falls between the `\r` and the `\n` of a CRLF in `doc`: no LSP position names it. */
function insideCrlf(doc, at) {
  if (at <= 0 || at >= doc.length) return false
  return doc.sliceString(at - 1, at + 1) === '\r\n'
}

/**
 * A transaction's changes (CodeMirror ChangeSet: `iterChanges((fromA, toA, fromB, toB, inserted))`,
 * `inserted` a Text) as LSP incremental content changes against `startDoc`. They are listed from
 * the end of the document backwards, so each range is still right after the ones before it are
 * applied (LSP applies them in order). Null when a change starts or ends between a CRLF's `\r` and
 * `\n` (the page shows the `\r`, so a cursor can sit there): LSP has no position for that point, so
 * the client sends the whole text again instead (client.mjs `changed`).
 */
export function contentChanges(startDoc, changes) {
  const out = []
  let unnamed = false
  changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    if (insideCrlf(startDoc, fromA) || insideCrlf(startDoc, toA)) unnamed = true
    out.push({ range: { start: positionOf(startDoc, fromA), end: positionOf(startDoc, toA) }, text: inserted.toString() })
  })
  return unnamed ? null : out.reverse()
}

const before = (a, b) => a.line < b.line || (a.line === b.line && a.character < b.character)

/**
 * The host's TextEdits for this buffer as CodeMirror changes `[{ from, to, insert }]`, sorted, or a
 * string saying why not (an overlap, a malformed edit). The host checked them already; the page
 * checks again since its buffer is what they touch.
 */
export function editsToChanges(doc, edits) {
  if (!Array.isArray(edits)) return 'not a list of edits'
  const list = []
  for (const e of edits) {
    if (!e || typeof e !== 'object' || typeof e.newText !== 'string' || !e.range || !e.range.start || !e.range.end) return 'a malformed edit'
    if (before(e.range.end, e.range.start)) return 'an edit ends before it starts'
    list.push(e)
  }
  // The host's order (lib/lsp/edits.js sortEdits): by start, then end, then as listed, so an insert
  // at P listed after a replace starting at P sorts before it instead of reading as an overlap.
  const cmp = (a, b) => (before(a, b) ? -1 : before(b, a) ? 1 : 0)
  const sorted = list.map((e, i) => ({ e, i })).sort((a, b) => cmp(a.e.range.start, b.e.range.start) || cmp(a.e.range.end, b.e.range.end) || a.i - b.i)
  const out = []
  for (let k = 0; k < sorted.length; k++) {
    const e = sorted[k].e
    if (k > 0 && before(e.range.start, sorted[k - 1].e.range.end)) return 'the edits overlap'
    out.push({ from: offsetOf(doc, e.range.start), to: offsetOf(doc, e.range.end), insert: e.newText })
  }
  return out
}

/**
 * An LSP snippet (`insertTextFormat` 2) as a CodeMirror snippet template. LSP: `$1`, `${1}`,
 * `${1:text}` (nested placeholders flattened to their text), `${1|a,b|}` (the first choice), `$0`
 * the final cursor, `$NAME`/`${NAME:default}` variables (their default, else nothing), `\$ \} \\`
 * escapes. CodeMirror: `${1:name}` fields, `${0}` the end, and `\{`/`\}` for a literal brace; a field
 * name may hold no brace, so a placeholder text with one becomes plain text and an empty field.
 */
export function snippetToTemplate(src) {
  let i = 0
  const lit = (s) => s.replace(/[{}]/g, (c) => `\\${c}`)

  // Reads until `stop` (a character, or end of input when null) at this nesting level; returns the
  // CodeMirror template text and the plain text of what it read (for a placeholder's name).
  function seq(stop) {
    let tpl = ''
    let plain = ''
    while (i < src.length) {
      const c = src[i]
      if (stop !== null && c === stop) break
      if (c === '\\' && i + 1 < src.length && '$}\\,|'.includes(src[i + 1])) {
        tpl += lit(src[i + 1])
        plain += src[i + 1]
        i += 2
        continue
      }
      if (c === '$') {
        const r = dollar()
        if (r) {
          tpl += r.tpl
          plain += r.plain
          continue
        }
      }
      tpl += lit(c)
      plain += c
      i++
    }
    return { tpl, plain }
  }

  function field(n, name) {
    if (name === '') return `\${${n}}`
    if (/[{}]/.test(name)) return `${lit(name)}\${${n}}`
    return `\${${n}:${name}}`
  }

  // At a `$`: a tab stop, placeholder, choice or variable; null when it is a plain `$`.
  function dollar() {
    const start = i
    const rest = src.slice(i + 1)
    let m = /^(\d+)/.exec(rest)
    if (m) {
      i += 1 + m[1].length
      return { tpl: field(Number(m[1]), ''), plain: '' }
    }
    m = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(rest)
    if (m) {
      // A variable we do not resolve (TM_FILENAME, CLIPBOARD...): nothing.
      i += 1 + m[1].length
      return { tpl: '', plain: '' }
    }
    if (rest[0] !== '{') return null
    i += 2
    m = /^(\d+)/.exec(src.slice(i))
    if (m) {
      const n = Number(m[1])
      i += m[1].length
      if (src[i] === '}') {
        i++
        return { tpl: field(n, ''), plain: '' }
      }
      if (src[i] === ':') {
        i++
        const inner = seq('}')
        i++
        return { tpl: field(n, inner.plain), plain: inner.plain }
      }
      if (src[i] === '|') {
        i++
        const choice = seq('|')
        i++ // the closing |
        if (src[i] === '}') i++
        const first = choice.plain.split(',')[0]
        return { tpl: field(n, first), plain: first }
      }
    }
    m = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(src.slice(i))
    if (m) {
      i += m[1].length
      if (src[i] === '}') {
        i++
        return { tpl: '', plain: '' }
      }
      if (src[i] === ':') {
        i++
        const inner = seq('}')
        i++
        return { tpl: inner.tpl, plain: inner.plain }
      }
    }
    // Not snippet syntax after all: a literal `$`.
    i = start
    return null
  }

  return seq(null).tpl
}

/**
 * A hover's or a documentation's contents (MarkupContent, MarkedString or a list of them) as
 * blocks to draw `[{ code, text }]`: fenced code blocks and `{ language, value }` strings are code,
 * the rest text (shown as it is: no markup is ever rendered from a server).
 */
export function docBlocks(contents) {
  const out = []
  const add = (v) => {
    if (typeof v === 'string') return markdownBlocks(v, out)
    if (!v || typeof v !== 'object' || typeof v.value !== 'string') return
    if (typeof v.language === 'string') return out.push({ code: true, text: v.value })
    if (v.kind === 'plaintext') return out.push({ code: false, text: v.value })
    markdownBlocks(v.value, out)
  }
  if (Array.isArray(contents)) contents.forEach(add)
  else add(contents)
  return out.filter((b) => b.text.trim() !== '')
}

function markdownBlocks(md, out) {
  const lines = md.split('\n')
  let buf = []
  let code = false
  const flush = () => {
    const text = buf.join('\n').replace(/^\n+|\n+$/g, '')
    if (text) out.push({ code, text })
    buf = []
  }
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      flush()
      code = !code
      continue
    }
    buf.push(line)
  }
  flush()
  return out
}

/** LSP SymbolKind names (1-based). */
const SYMBOL_KINDS = ['', 'file', 'module', 'namespace', 'package', 'class', 'method', 'property', 'field', 'constructor', 'enum', 'interface', 'function', 'variable', 'constant', 'string', 'number', 'boolean', 'array', 'object', 'key', 'null', 'enum member', 'struct', 'event', 'operator', 'type parameter']

const MAX_SYMBOLS = 5000

/**
 * A documentSymbol answer (DocumentSymbol trees or flat SymbolInformation) as rows in document
 * order: `[{ name, detail, kind, depth, line, character }]`, the position the symbol's name.
 */
export function flattenSymbols(result) {
  const out = []
  const walk = (list, depth) => {
    for (const s of Array.isArray(list) ? list : []) {
      if (out.length >= MAX_SYMBOLS) return
      if (!s || typeof s !== 'object' || typeof s.name !== 'string') continue
      const r = s.selectionRange || s.range || (s.location && s.location.range)
      if (!r || !r.start) continue
      out.push({
        name: s.name,
        detail: typeof s.detail === 'string' ? s.detail : typeof s.containerName === 'string' ? s.containerName : '',
        kind: SYMBOL_KINDS[s.kind] || '',
        depth,
        line: r.start.line,
        character: r.start.character,
      })
      if (Array.isArray(s.children)) walk(s.children, depth + 1)
    }
  }
  walk(result, 0)
  // SymbolInformation lists come in any order.
  if (out.length && out.every((s) => s.depth === 0)) out.sort((a, b) => a.line - b.line || a.character - b.character)
  return out
}

/** CompletionItemKind -> CodeMirror's completion `type` (its icon). */
const COMPLETION_TYPES = {
  1: 'text', 2: 'method', 3: 'function', 4: 'function', 5: 'property', 6: 'variable', 7: 'class', 8: 'interface', 9: 'namespace',
  10: 'property', 11: 'constant', 12: 'constant', 13: 'enum', 14: 'keyword', 15: 'text', 16: 'constant', 17: 'text', 18: 'text',
  19: 'text', 20: 'constant', 21: 'constant', 22: 'class', 23: 'text', 24: 'text', 25: 'type',
}
export const completionType = (kind) => COMPLETION_TYPES[kind] || 'text'

/** DiagnosticSeverity -> CodeMirror lint severity. */
export const severityOf = (n) => (n === 2 ? 'warning' : n === 3 ? 'info' : n === 4 ? 'hint' : 'error')

/**
 * The active signature of a signatureHelp answer, split around its active parameter for drawing:
 * `{ before, param, after, doc, count, index }`, or null when there is none.
 */
export function signatureParts(help) {
  if (!help || !Array.isArray(help.signatures) || help.signatures.length === 0) return null
  const index = Number.isInteger(help.activeSignature) && help.activeSignature >= 0 && help.activeSignature < help.signatures.length ? help.activeSignature : 0
  const sig = help.signatures[index]
  if (!sig || typeof sig.label !== 'string') return null
  const label = sig.label
  const params = Array.isArray(sig.parameters) ? sig.parameters : []
  const active = Number.isInteger(sig.activeParameter) ? sig.activeParameter : Number.isInteger(help.activeParameter) ? help.activeParameter : 0
  const p = params[active]
  let from = -1
  let to = -1
  if (p && Array.isArray(p.label) && Number.isInteger(p.label[0]) && Number.isInteger(p.label[1]) && p.label[0] <= p.label[1] && p.label[1] <= label.length) {
    ;[from, to] = p.label
  } else if (p && typeof p.label === 'string' && p.label) {
    from = label.indexOf(p.label)
    to = from < 0 ? -1 : from + p.label.length
  }
  const doc = p && p.documentation !== undefined ? docBlocks(p.documentation) : sig.documentation !== undefined ? docBlocks(sig.documentation) : []
  if (from < 0) return { before: label, param: '', after: '', doc, count: help.signatures.length, index }
  return { before: label.slice(0, from), param: label.slice(from, to), after: label.slice(to), doc, count: help.signatures.length, index }
}
