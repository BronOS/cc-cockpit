// The title Claude Code gives its terminal, read from a Claude tab's PTY output so the tab can be
// named after its topic instead of "Claude N" (session-registry.ts `tabOutput`).
//
// What Claude sets, observed with claude 2.1.316 in a real PTY (a scratch folder, "say hi in two
// words", then "what is 2+2"): OSC 0 terminated by BEL, a status glyph, a space and the text.
//     ESC ] 0 ; ✳ Claude Code BEL            at start, before any topic exists
//     ESC ] 0 ; ◐ Claude Code BEL            ◐/◑ alternate while the first turn works
//     ESC ] 0 ; ◑ Greeting in two words BEL  the topic Claude generated from the first prompt
//     ESC ] 0 ; ✳ Greeting in two words BEL  idle again; the second prompt kept the topic
//     ESC ] 0 ; BEL                          at exit (the terminal's title reset)
// So the glyph is status, not name: it changes on every spinner frame and is stripped, and the
// plain "Claude Code" means no topic yet. `CLAUDE_CODE_DISABLE_TERMINAL_TITLE` (in the binary)
// turns the title off; the tab then keeps its fallback name.
//
// The parser takes OSC 0 and OSC 2 (the window title; 1 is the icon name), ended by BEL or ST
// (`ESC \`), across chunk boundaries (a PTY read can end anywhere, ESC included). It holds at most
// MAX_OSC_BODY characters of an unfinished sequence, and drops a sequence as soon as its number is
// not 0 or 2, so an OSC 52 clipboard write of megabytes is never buffered. Everything else in the
// stream is skipped with indexOf: this runs on every chunk a Claude tab prints.

const ESC = '\x1b'
const BEL = '\x07'
/** A title body longer than this (Claude's are a few words) is not a title we keep. */
const MAX_OSC_BODY = 1024
/** What the tab name may hold after cleaning. */
export const MAX_TITLE_CHARS = 120

/** A title Claude sets while it has no topic: not a name, the fallback stays. */
const GENERIC_TITLES: ReadonlySet<string> = new Set(['claude code', 'claude'])

export class TitleParser {
  /** The body (after `ESC ]`) of a sequence an earlier chunk started; undefined outside one. */
  private body: string | undefined
  /** The last chunk ended in ESC: the start of `ESC ]`, or of the ST `ESC \` inside a body. */
  private esc = false

  /** Read one chunk; the raw text of the last OSC 0/2 title completed in it, else undefined. */
  feed(chunk: string): string | undefined {
    let text = chunk
    if (this.esc) {
      text = ESC + text
      this.esc = false
    }
    let title: string | undefined
    let i = 0
    while (i < text.length) {
      if (this.body === undefined) {
        const at = text.indexOf(ESC + ']', i)
        if (at === -1) {
          if (text.endsWith(ESC)) this.esc = true
          break
        }
        this.body = ''
        i = at + 2
        continue
      }
      const bel = text.indexOf(BEL, i)
      const esc = text.indexOf(ESC, i)
      const end = bel === -1 ? esc : esc === -1 ? bel : Math.min(bel, esc)
      if (end === -1) {
        this.append(text.slice(i))
        break
      }
      this.append(text.slice(i, end))
      if (end === bel) {
        title = this.finish() ?? title
        i = end + 1
      } else if (end === text.length - 1) {
        // ESC as the chunk's last character: ST or not is decided by the next chunk.
        this.esc = true
        break
      } else if (text[end + 1] === '\\') {
        title = this.finish() ?? title
        i = end + 2
      } else {
        // Any other ESC aborts the sequence (as in xterm) and may start the next one.
        this.body = undefined
        i = end
      }
    }
    return title
  }

  private append(part: string): void {
    if (this.body === undefined) return
    const body = this.body + part
    // Dropped (back to scanning) once it cannot be a title. The rest of a dropped sequence's body
    // holds no ESC (an ESC would have ended it), so the scan skips it harmlessly.
    if (body.length > MAX_OSC_BODY || (body.length >= 2 && !/^[02];/.test(body)) || (body.length === 1 && body !== '0' && body !== '2')) {
      this.body = undefined
      return
    }
    this.body = body
  }

  private finish(): string | undefined {
    const body = this.body
    this.body = undefined
    return body !== undefined && /^[02];/.test(body) ? body.slice(2) : undefined
  }
}

/**
 * The tab name a raw title gives: control and format characters out, the leading status glyph
 * (one or two symbol or punctuation characters before a space: ✳, ◐, ⠋, ✢, ·) out, whitespace
 * collapsed, capped. Undefined for a title that names nothing: empty (the reset at exit) or
 * Claude's generic one.
 */
export function cleanTitle(raw: string): string | undefined {
  let text = raw.replace(/[\p{Cc}\p{Cf}]/gu, ' ')
  text = text.replace(/^\s*[\p{S}\p{P}]{1,2}\s+/u, '')
  text = text.replace(/\s+/g, ' ').trim()
  if (text === '' || GENERIC_TITLES.has(text.toLowerCase())) return undefined
  if (text.length <= MAX_TITLE_CHARS) return text
  // Not mid surrogate pair: the cut lands before a high surrogate if one is last.
  const last = text.charCodeAt(MAX_TITLE_CHARS - 1)
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? MAX_TITLE_CHARS - 1 : MAX_TITLE_CHARS)
}
