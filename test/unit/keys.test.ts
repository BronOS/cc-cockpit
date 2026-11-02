import { describe, expect, it } from 'vitest'
import { chordFromEvent, normalizeChord, resolveKeys, splitChord, type KeyEventLike } from '../../src/shared/keys'

const ev = (over: Partial<KeyEventLike>): KeyEventLike => ({
  key: 'a',
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...over
})

describe('normalizeChord', () => {
  it('orders modifiers and lower-cases', () => {
    expect(normalizeChord('Cmd+Shift+P', 'darwin')).toBe('shift+meta+p')
    expect(normalizeChord('shift+cmd+p', 'darwin')).toBe('shift+meta+p')
    expect(normalizeChord('Alt+Ctrl+x', 'darwin')).toBe('ctrl+alt+x')
  })

  it('maps cmd to Ctrl on Linux and Windows, to Meta on macOS', () => {
    expect(normalizeChord('Cmd+T', 'linux')).toBe('ctrl+t')
    expect(normalizeChord('CmdOrCtrl+T', 'win32')).toBe('ctrl+t')
    expect(normalizeChord('Cmd+T', 'darwin')).toBe('meta+t')
    // An explicit Ctrl stays Ctrl on macOS.
    expect(normalizeChord('Ctrl+T', 'darwin')).toBe('ctrl+t')
  })

  it('accepts aliases, named keys and the plus key', () => {
    expect(normalizeChord('Esc', 'darwin')).toBe('escape')
    expect(normalizeChord('Cmd+,', 'darwin')).toBe('meta+,')
    expect(normalizeChord('Cmd++', 'darwin')).toBe('meta++')
    expect(normalizeChord('Cmd+ArrowLeft', 'darwin')).toBe('meta+left')
    expect(normalizeChord('F5', 'linux')).toBe('f5')
  })

  it('rejects malformed chords', () => {
    for (const bad of ['', '  ', 'Cmd+', 'Cmd+Shift', 'Hyper+T', 'Cmd+Cmd+T', 'Cmd+Foo', 'T']) {
      expect(normalizeChord(bad, 'darwin'), bad).toBeNull()
    }
    // CmdOrCtrl and Ctrl are the same modifier on Linux: repeating it is an error.
    expect(normalizeChord('Cmd+Ctrl+T', 'linux')).toBeNull()
  })

  it('does not count Shift alone as a modifier on a typing key (it would take K, Shift+Enter, Shift+Tab from the terminal)', () => {
    for (const bad of ['Shift+K', 'Shift+1', 'Shift+Enter', 'Shift+Tab', 'Shift+Space', 'Shift+/']) {
      expect(normalizeChord(bad, 'darwin'), bad).toBeNull()
    }
    expect(normalizeChord('Shift+F1', 'darwin')).toBe('shift+f1')
    expect(normalizeChord('Shift+Esc', 'darwin')).toBe('shift+escape')
    expect(normalizeChord('Ctrl+Shift+K', 'darwin')).toBe('ctrl+shift+k')
  })

  it('does not take Object.prototype members for modifiers or key names (constructor+p was a bare p)', () => {
    for (const proto of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      for (const bad of [`${proto}+p`, `${proto}+Shift+p`, `Cmd+${proto}`, `Cmd+${proto}+p`]) {
        for (const platform of ['darwin', 'linux'] as const) {
          expect(normalizeChord(bad, platform), `${bad} on ${platform}`).toBeNull()
        }
      }
    }
  })
})

describe('splitChord', () => {
  it("takes '+' as the key when it follows a separator, or alone", () => {
    expect(splitChord('meta++')).toEqual({ mods: ['meta'], key: '+' })
    expect(splitChord('ctrl+shift++')).toEqual({ mods: ['ctrl', 'shift'], key: '+' })
    expect(splitChord('+')).toEqual({ mods: [], key: '+' })
    expect(splitChord('shift+meta+p')).toEqual({ mods: ['shift', 'meta'], key: 'p' })
    expect(splitChord('escape')).toEqual({ mods: [], key: 'escape' })
  })

  it('refuses empty parts', () => {
    for (const bad of ['', 'meta+', '++', '+++', 'meta+++', 'meta++p', '+p', 'ctrl++meta+p']) {
      expect(splitChord(bad), bad).toBeNull()
    }
  })

  it('takes apart every chord normalizeChord accepts, and normalizeChord refuses what it cannot', () => {
    for (const input of ['Cmd++', 'Cmd+Plus', 'Ctrl+Shift++', 'Cmd+Shift+P', 'Esc', 'F5', 'Cmd+,', 'Alt+Ctrl+x']) {
      const chord = normalizeChord(input, 'darwin')
      expect(chord, input).not.toBeNull()
      expect(splitChord(chord as string), input).not.toBeNull()
    }
    for (const bad of ['+', '++', 'meta+', 'meta+++', 'Cmd++P', ' + ']) {
      expect(normalizeChord(bad, 'darwin'), bad).toBeNull()
    }
  })
})

describe('chordFromEvent', () => {
  it('matches what normalizeChord writes', () => {
    expect(chordFromEvent(ev({ key: 'P', shiftKey: true, metaKey: true }))).toBe(
      normalizeChord('Cmd+Shift+P', 'darwin')
    )
    expect(chordFromEvent(ev({ key: ',', metaKey: true }))).toBe('meta+,')
    expect(chordFromEvent(ev({ key: 'Escape' }))).toBe('escape')
    expect(chordFromEvent(ev({ key: 'ArrowLeft', metaKey: true }))).toBe('meta+left')
  })

  it('reads digits and Option letters from the physical key', () => {
    expect(chordFromEvent(ev({ key: '!', code: 'Digit1', shiftKey: true, metaKey: true }))).toBe(
      'shift+meta+1'
    )
    expect(chordFromEvent(ev({ key: '≈', code: 'KeyX', altKey: true, metaKey: true }))).toBe(
      'alt+meta+x'
    )
  })

  it('falls back to the physical key on non-Latin and AZERTY layouts', () => {
    // Cyrillic: Cmd+T types 'е'.
    expect(chordFromEvent(ev({ key: 'е', code: 'KeyT', metaKey: true }))).toBe('meta+t')
    // AZERTY: Cmd+1 types '&'.
    expect(chordFromEvent(ev({ key: '&', code: 'Digit1', metaKey: true }))).toBe('meta+1')
    // A Latin layout keeps its own letters (Dvorak: the key at KeyT types 'y').
    expect(chordFromEvent(ev({ key: 'y', code: 'KeyT', metaKey: true }))).toBe('meta+y')
  })

  it('unshifts punctuation', () => {
    expect(chordFromEvent(ev({ key: '<', code: 'Comma', shiftKey: true, metaKey: true }))).toBe(
      normalizeChord('Cmd+Shift+,', 'darwin')
    )
    expect(chordFromEvent(ev({ key: '?', shiftKey: true, metaKey: true }))).toBe('shift+meta+/')
  })

  it('does not map a key through an Object.prototype member of its tables', () => {
    expect(chordFromEvent(ev({ key: 'constructor', shiftKey: true, metaKey: true }))).toBe('shift+meta+constructor')
    expect(chordFromEvent(ev({ key: '__proto__', metaKey: true }))).toBe('meta+__proto__')
  })

  it('ignores a lone modifier press', () => {
    expect(chordFromEvent(ev({ key: 'Meta', metaKey: true }))).toBeNull()
    expect(chordFromEvent(ev({ key: 'Shift', shiftKey: true }))).toBeNull()
  })
})

describe('resolveKeys', () => {
  const cmds = [
    { id: 'a', key: 'Cmd+T' },
    { id: 'b', key: 'Cmd+W' },
    { id: 'c' }
  ]

  it('binds the defaults', () => {
    const r = resolveKeys(cmds, {}, 'darwin')
    expect(r.bindings.get('meta+t')).toBe('a')
    expect(r.keys.get('b')).toBe('meta+w')
    expect(r.keys.has('c')).toBe(false)
    expect(r.conflicts).toEqual([])
  })

  it('an override replaces the default instead of adding a second chord', () => {
    const r = resolveKeys(cmds, { a: 'Cmd+Shift+N' }, 'darwin')
    expect(r.bindings.get('shift+meta+n')).toBe('a')
    expect(r.bindings.has('meta+t')).toBe(false)
  })

  it('an empty override unbinds, and a command without a default can be given one', () => {
    const r = resolveKeys(cmds, { b: '', c: 'Cmd+K' }, 'darwin')
    expect(r.keys.has('b')).toBe(false)
    expect(r.bindings.get('meta+k')).toBe('c')
  })

  it('reports a conflict between two defaults and binds neither', () => {
    const r = resolveKeys([{ id: 'x', key: 'Cmd+T' }, { id: 'y', key: 'cmd+t' }], {}, 'darwin')
    expect(r.conflicts).toEqual([{ chord: 'meta+t', commands: ['x', 'y'] }])
    expect(r.bindings.has('meta+t')).toBe(false)
  })

  it('a user override beats a default it collides with, still reported', () => {
    const r = resolveKeys(cmds, { c: 'Cmd+T' }, 'darwin')
    expect(r.conflicts).toEqual([{ chord: 'meta+t', commands: ['a', 'c'] }])
    expect(r.bindings.get('meta+t')).toBe('c')
  })

  it('a core default beats a plugin default for the same chord, still reported', () => {
    const r = resolveKeys(
      [
        { id: 'core.t', key: 'Cmd+T', core: true },
        { id: 'plug/t', key: 'Cmd+T' }
      ],
      {},
      'darwin'
    )
    expect(r.conflicts).toEqual([{ chord: 'meta+t', commands: ['core.t', 'plug/t'] }])
    expect(r.bindings.get('meta+t')).toBe('core.t')
    // The user can still take it for the plugin command.
    const u = resolveKeys(
      [
        { id: 'core.t', key: 'Cmd+T', core: true },
        { id: 'plug/t', key: 'Cmd+K' }
      ],
      { 'plug/t': 'Cmd+T' },
      'darwin'
    )
    expect(u.bindings.get('meta+t')).toBe('plug/t')
  })

  it('two user overrides on one chord bind neither', () => {
    const r = resolveKeys(cmds, { a: 'Cmd+K', c: 'Cmd+K' }, 'darwin')
    expect(r.conflicts).toHaveLength(1)
    expect(r.bindings.has('meta+k')).toBe(false)
  })

  it('ignores overrides for unknown commands and invalid chords', () => {
    const r = resolveKeys(cmds, { ghost: 'Cmd+G', a: 'nonsense' }, 'darwin')
    expect(r.ignored.sort()).toEqual(['a', 'ghost'])
    // The invalid override leaves the default in place.
    expect(r.bindings.get('meta+t')).toBe('a')
    expect(r.bindings.has('meta+g')).toBe(false)
  })

  it('uses Ctrl for cmd on Linux', () => {
    expect(resolveKeys(cmds, {}, 'linux').bindings.get('ctrl+t')).toBe('a')
  })

  it('binds nothing for a default or an override written with an Object.prototype member', () => {
    const r = resolveKeys([...cmds, { id: 'plug/p', key: 'constructor+p' }], { b: '__proto__+w' }, 'darwin')
    expect(r.keys.has('plug/p')).toBe(false)
    expect(r.bindings.has('p')).toBe(false)
    expect(r.bindings.has('w')).toBe(false)
    expect(r.ignored).toEqual(['b'])
  })
})
