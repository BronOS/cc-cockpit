// qa-carol blind verify (Terminal panel, design-terminal-panel.md §13.13): the toggle chords are written
// `Ctrl+\`` and `Ctrl+Shift+\``, and a key event from the physical Backquote key must give the same chord on
// layouts where that key types something else (Cyrillic `ё`, a German dead key, `§`, AZERTY `²`), while the
// US event and the other chords stay as they were.
import { describe, expect, it } from 'vitest'
import { chordFromEvent, normalizeChord, type KeyEventLike } from '../../src/shared/keys'

const ev = (key: string, code: string, mods: Partial<Omit<KeyEventLike, 'key' | 'code'>> = {}): KeyEventLike => ({
  key,
  code,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...mods
})

const TOGGLE = normalizeChord('Ctrl+`', 'linux')
const NEW = normalizeChord('Ctrl+Shift+`', 'linux')

describe('qa: Terminal panel chords on other layouts', () => {
  it('the written chords normalize the same on every platform (Ctrl stays Ctrl on macOS)', () => {
    expect(TOGGLE).not.toBeNull()
    expect(NEW).not.toBeNull()
    expect(normalizeChord('Ctrl+`', 'darwin')).toBe(TOGGLE)
    expect(normalizeChord('Ctrl+Shift+`', 'darwin')).toBe(NEW)
    // On macOS `Cmd+\`` is the system's window cycling: it must not be the same chord as Ctrl+`.
    expect(normalizeChord('Cmd+`', 'darwin')).not.toBe(TOGGLE)
  })

  it('US layout: Ctrl+` and Ctrl+Shift+` (Shift turns the key into ~)', () => {
    expect(chordFromEvent(ev('`', 'Backquote', { ctrlKey: true }))).toBe(TOGGLE)
    expect(chordFromEvent(ev('~', 'Backquote', { ctrlKey: true, shiftKey: true }))).toBe(NEW)
  })

  it.each([
    ['Cyrillic ё', 'ё', 'Ё'],
    // A German layout's key reports 'Dead' with Ctrl in Chromium. Where it resolves to an ASCII '^' the
    // event keeps its key (the Dvorak rule of chordFromEvent: an ASCII key is matched as typed), so it
    // is Ctrl+^, not the toggle: noted in the QA report, not asserted.
    ['German dead key', 'Dead', 'Dead'],
    ['ISO §', '§', '±'],
    ['AZERTY ²', '²', '²']
  ])('%s on the Backquote key gives the same chords', (_name, plain, shifted) => {
    expect(chordFromEvent(ev(plain, 'Backquote', { ctrlKey: true }))).toBe(TOGGLE)
    expect(chordFromEvent(ev(shifted, 'Backquote', { ctrlKey: true, shiftKey: true }))).toBe(NEW)
  })

  it('no regression: Cyrillic letters still map by code, a plain ё stays itself, other punctuation unchanged', () => {
    // Cyrillic Ctrl+T (`е` on the KeyT key) was already mapped by code.
    expect(chordFromEvent(ev('е', 'KeyT', { ctrlKey: true }))).toBe(normalizeChord('Ctrl+T', 'linux'))
    // Without a modifier the Backquote key is typing (ё is a letter): it must not turn into a chord
    // that equals a command's, and no command is bound to a bare backquote.
    const bare = chordFromEvent(ev('ё', 'Backquote'))
    expect(bare === 'ё' || bare === '`').toBe(true)
    expect(chordFromEvent(ev('\\', 'Backslash', { ctrlKey: true }))).toBe(normalizeChord('Ctrl+\\', 'linux'))
  })
})
