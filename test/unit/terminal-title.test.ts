// The terminal title of a Claude tab (src/main/sessions/terminal-title.ts). The sequences are the
// ones claude 2.1.316 printed in a real PTY (see the file's header).
import { describe, expect, it } from 'vitest'
import { cleanTitle, MAX_TITLE_CHARS, TitleParser } from '../../src/main/sessions/terminal-title'

const osc = (text: string, end = '\x07'): string => `\x1b]0;${text}${end}`

describe('TitleParser', () => {
  it('reads OSC 0 and OSC 2 ended by BEL or ST, the last of a chunk winning', () => {
    const p = new TitleParser()
    expect(p.feed(`\x1b[?25l${osc('✳ Claude Code')}\x1b[2K`)).toBe('✳ Claude Code')
    expect(p.feed(`${osc('◐ Claude Code')}text${osc('◑ Greeting in two words')}`)).toBe('◑ Greeting in two words')
    expect(p.feed('\x1b]2;window title\x1b\\')).toBe('window title')
    expect(p.feed('plain output, no title')).toBeUndefined()
  })

  it('ignores other OSC numbers and does not buffer them', () => {
    const p = new TitleParser()
    expect(p.feed('\x1b]1;icon\x07\x1b]7501;?\x07\x1b]8;;https://x\x07link\x1b]8;;\x07')).toBeUndefined()
    // An OSC 52 clipboard write of a megabyte, split over chunks: nothing kept, nothing found.
    expect(p.feed(`\x1b]52;c;${'QUJD'.repeat(100_000)}`)).toBeUndefined()
    expect(p.feed(`${'QUJD'.repeat(100_000)}\x07`)).toBeUndefined()
    expect(p.feed(osc('✳ after'))).toBe('✳ after')
  })

  it('reads a title split across chunks anywhere, the ESC of ST included', () => {
    const whole = `ab${osc('✳ File tree plugin', '\x1b\\')}cd`
    for (let cut = 1; cut < whole.length; cut++) {
      const p = new TitleParser()
      const first = p.feed(whole.slice(0, cut))
      const second = p.feed(whole.slice(cut))
      expect(first ?? second, `cut at ${cut}`).toBe('✳ File tree plugin')
    }
  })

  it('drops a sequence another ESC aborts, and one too long to be a title', () => {
    const p = new TitleParser()
    expect(p.feed('\x1b]0;half\x1b[31mred')).toBeUndefined()
    expect(p.feed(osc('x'.repeat(5000)))).toBeUndefined()
    expect(p.feed(osc('✳ next'))).toBe('✳ next')
  })
})

describe('cleanTitle', () => {
  it('strips the status glyph Claude animates, so every frame gives the same name', () => {
    for (const glyph of ['✳', '◐', '◑', '⠋', '⠹', '✢', '✶', '✻', '✽', '·', '*']) {
      expect(cleanTitle(`${glyph} File tree plugin`)).toBe('File tree plugin')
    }
  })

  it('names nothing for an empty title or Claude generic one', () => {
    expect(cleanTitle('')).toBeUndefined()
    expect(cleanTitle('   ')).toBeUndefined()
    expect(cleanTitle('✳ Claude Code')).toBeUndefined()
    expect(cleanTitle('◐ claude code')).toBeUndefined()
  })

  it('takes control characters out, collapses whitespace and caps the length', () => {
    expect(cleanTitle('✳ Fix\tthe​  bug\r\n')).toBe('Fix the bug')
    const long = cleanTitle(`✳ ${'a'.repeat(MAX_TITLE_CHARS - 1)}😀tail`) as string
    expect(long.length).toBe(MAX_TITLE_CHARS - 1)
    expect(long.endsWith('a')).toBe(true)
    // A title without a glyph keeps its first word.
    expect(cleanTitle('Refactor auth')).toBe('Refactor auth')
  })
})
