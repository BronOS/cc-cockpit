import { describe, expect, it } from 'vitest'
import { unwrapPastes } from '../../src/main/sessions/paste-wrappers'

/** A paste as claude 2.1.316 puts it into the UserPromptSubmit prompt. */
const wrap = (id: string, body: string): string => `<pasted_content id="${id}">\n${body}\n</pasted_content id="${id}">\n`

describe('unwrapPastes', () => {
  it('keeps the pasted text and drops the tags (the incident: a card showing the raw wrapper)', () => {
    expect(unwrapPastes(wrap('91a8', 'npm ERR! missing script'))).toBe('npm ERR! missing script\n')
  })

  it('keeps the typed text around the paste, newlines included', () => {
    expect(unwrapPastes(`why does this fail?\n${wrap('0f3c', 'line 1\nline 2')}thanks`)).toBe(
      'why does this fail?\nline 1\nline 2\nthanks'
    )
  })

  it('unwraps several pastes, each with its own id', () => {
    const text = `compare\n${wrap('aaaa', 'first')}with\n${wrap('b0b0', 'second')}`
    expect(unwrapPastes(text)).toBe('compare\nfirst\nwith\nsecond\n')
  })

  it('an empty paste leaves nothing behind', () => {
    expect(unwrapPastes('a <pasted_content id="1234">\n</pasted_content id="1234">\nb')).toBe('a \nb')
  })

  it('a longer id still counts (a later Claude version), any non-hex id does not', () => {
    expect(unwrapPastes(wrap('0123456789abcdef', 'x'))).toBe('x\n')
    for (const id of ['', '91A8', 'zz12', '9 1a']) expect(unwrapPastes(wrap(id, 'x'))).toBe(wrap(id, 'x'))
  })

  it('leaves alone anything that is not a whole wrapper', () => {
    const cases = [
      'plain text, no tags',
      // Typed by the user, on one line: no newline after the opener or before the closer.
      'what is <pasted_content id="91a8">x</pasted_content id="91a8"> for?',
      // The closer names another id.
      '<pasted_content id="91a8">\nx\n</pasted_content id="1111">\n',
      // A closer without its id (not Claude's format).
      '<pasted_content id="91a8">\nx\n</pasted_content>\n',
      // No closer at all.
      '<pasted_content id="91a8">\nhalf a paste',
      '<pasted_content>\nx\n</pasted_content>'
    ]
    for (const text of cases) expect(unwrapPastes(text)).toBe(text)
  })

  it('a bad opener before a good one does not stop the scan', () => {
    expect(unwrapPastes(`<pasted_content id="XY">\n${wrap('abcd', 'ok')}`)).toBe('<pasted_content id="XY">\nok\n')
  })

  it('does not unwrap a wrapper inside a pasted body a second time', () => {
    const inner = wrap('2222', 'inner')
    expect(unwrapPastes(wrap('1111', inner.trimEnd()))).toBe(`${inner.trimEnd()}\n`)
  })

  it('stays linear on a megabyte of unclosed openers', () => {
    const text = '<pasted_content id="91a8">\n'.repeat(40_000) + '<pasted_content id="91a9">\nx'
    const started = Date.now()
    expect(unwrapPastes(text)).toBe(text)
    expect(Date.now() - started).toBeLessThan(500)
  })
})
