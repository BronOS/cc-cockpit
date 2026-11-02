// Claude Code's paste wrappers, taken out of a prompt before it is stored as a tab's `lastPrompt`
// (status-reducer.ts), so the Sessions card, the top strip, `ccc sessions` and plugins'
// `ctx.sessions` all get the text the user saw (the incident: a card read
// `<pasted_content id="91a8"> ...`).
//
// Format, verified in claude 2.1.316 (the bundled source in the binary, no live session): the
// UserPromptSubmit `prompt` carries each paste as
//     <pasted_content id="91a8">\n<the pasted text>\n</pasted_content id="91a8">\n
// with a 4-hex-digit id (the first 4 of a sha256 hex digest) repeated in the closing tag. Claude's
// own parser takes an opener only with a valid id and the `">\n` after it, and its closer only as
// `\n</pasted_content id="<same id>">`. This follows it, so text the user typed that merely looks
// like a tag (no newline, another id, no closer) is left alone. The id may be any run of lowercase
// hex here (1-64 digits): a longer id in a later version must not bring the tags back.
//
// Linear time on purpose: the prompt is hook input of up to ~1 MiB. A matched block moves the scan
// past its closer, a bad opener past itself, and an opener with no closer ends the scan (Claude's
// parser stops there too): otherwise every unclosed opener would search to the end, n openers x n
// bytes, and hold main's event loop.

const OPEN = '<pasted_content id="'
const MAX_ID = 64

/** The id of an opener starting at `at`, or undefined unless `<pasted_content id="hex">\n` is there. */
function openerId(text: string, at: number): string | undefined {
  let end = at + OPEN.length
  const start = end
  while (end < text.length && end - start < MAX_ID) {
    const c = text.charCodeAt(end)
    if (!((c >= 48 && c <= 57) || (c >= 97 && c <= 102))) break // 0-9, a-f
    end++
  }
  if (end === start || !text.startsWith('">\n', end)) return undefined
  return text.slice(start, end)
}

/**
 * `text` with each paste wrapper removed and its pasted text kept where it stood: the opener with
 * its newline and the closer with the newline before it go, so `look:\n<open>\nlog\n<close>\nthanks`
 * reads `look:\nlog\nthanks`. Anything that is not a complete wrapper is kept as is.
 */
export function unwrapPastes(text: string): string {
  if (!text.includes(OPEN)) return text
  const out: string[] = []
  let kept = 0 // text before this index is in `out` already
  let from = 0 // where to look for the next opener
  for (;;) {
    const at = text.indexOf(OPEN, from)
    if (at === -1) break
    const id = openerId(text, at)
    if (id === undefined) {
      from = at + OPEN.length
      continue
    }
    const bodyStart = at + OPEN.length + id.length + 3
    const closer = `\n</pasted_content id="${id}">`
    // From the opener's own newline: an empty paste closes right after it.
    const close = text.indexOf(closer, bodyStart - 1)
    if (close === -1) break
    out.push(text.slice(kept, at), text.slice(bodyStart, Math.max(bodyStart, close)))
    kept = from = close + closer.length
  }
  if (kept === 0) return text
  out.push(text.slice(kept))
  return out.join('')
}
