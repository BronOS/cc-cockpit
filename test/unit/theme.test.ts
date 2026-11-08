import { describe, expect, it } from 'vitest'
import { BUILTIN_THEMES, ThemeService } from '../../src/main/themes/theme-service'
import {
  applyTheme,
  currentTheme,
  currentXtermTheme,
  onTheme,
  onXtermTheme,
  type ThemeRoot
} from '../../src/renderer/theme/theme-store'
import { isColor, validateTheme, type Theme } from '../../src/shared/theme'

const valid = {
  id: 'solar',
  name: 'Solar',
  kind: 'dark',
  vars: { '--cc-bg': '#002b36', '--custom-thing': 'rgb(1, 2, 3)' },
  xterm: { foreground: '#839496', red: 'hsl(1 50% 50%)' }
}

function errorsOf(patch: Record<string, unknown>): string[] {
  const r = validateTheme({ ...valid, ...patch })
  if (r.ok) throw new Error('expected a validation failure')
  return r.errors
}

describe('isColor', () => {
  it('accepts hex and functional colours', () => {
    for (const c of ['#fff', '#ffff', '#112233', '#11223344', 'rgb(1,2,3)', 'rgba(1, 2, 3, 0.5)', 'rgb(1 2 3 / 50%)', 'hsl(120deg 50% 50%)']) {
      expect(isColor(c), c).toBe(true)
    }
  })
  it('refuses everything else, including values that could escape a style declaration', () => {
    for (const c of ['red', '#12', '#12345', 'rgb(1,2)', 'url(x)', 'rgb(1,2,3); background: red', '', 5, null]) {
      expect(isColor(c), String(c)).toBe(false)
    }
  })
})

describe('validateTheme', () => {
  it('accepts a valid theme, unknown var names included, and returns a copy', () => {
    const r = validateTheme(valid)
    expect(r).toEqual({ ok: true, theme: valid })
    if (r.ok) expect(r.theme).not.toBe(valid)
  })

  it('accepts the built-in themes', () => {
    for (const t of BUILTIN_THEMES) expect(validateTheme(t).ok).toBe(true)
    expect(BUILTIN_THEMES.map((t) => t.kind).sort()).toEqual(['dark', 'light'])
  })

  it('rejects a non-object', () => {
    for (const v of [null, 'x', 3, [], undefined]) expect(validateTheme(v).ok).toBe(false)
  })

  it('reports every problem at once', () => {
    const errors = errorsOf({ id: '../x', name: '', kind: 'blue' })
    expect(errors).toHaveLength(3)
    expect(errors.join('\n')).toMatch(/id must match/)
    expect(errors.join('\n')).toMatch(/name/)
    expect(errors.join('\n')).toMatch(/kind/)
  })

  it('rejects bad var names and non-colour values', () => {
    const errors = errorsOf({ vars: { 'no-dashes': '#fff', '--ok': 'notacolour', '--fine': '#fff' } })
    expect(errors).toEqual([
      'vars: "no-dashes" is not a CSS variable name (--name)',
      'vars: --ok is not a colour'
    ])
  })

  it('rejects unknown xterm keys and non-colour values', () => {
    const errors = errorsOf({ xterm: { foreground: 'x', fontSize: '#fff' } })
    expect(errors).toEqual(['xterm: foreground is not a colour', 'xterm: unknown key "fontSize"'])
  })

  it('rejects missing or mistyped vars and xterm', () => {
    expect(errorsOf({ vars: [], xterm: 'x' })).toEqual(['vars must be an object', 'xterm must be an object'])
  })
})

describe('validateTheme size caps', () => {
  it('refuses an over-long value, an over-long variable name and too many entries', () => {
    expect(errorsOf({ vars: { '--a': '#' + 'f'.repeat(200) } }).join()).toMatch(/not a colour/)
    expect(errorsOf({ vars: { ['--' + 'a'.repeat(200)]: '#fff' } }).join()).toMatch(/not a CSS variable name/)
    const many = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`--v${i}`, '#fff']))
    expect(errorsOf({ vars: many }).join()).toMatch(/at most 200/)
  })
})

describe('applyTheme', () => {
  const fakeRoot = (): ThemeRoot & { props: Map<string, string> } => {
    const props = new Map<string, string>()
    return {
      props,
      style: {
        colorScheme: '',
        setProperty: (n: string, v: string) => void props.set(n, v),
        removeProperty: (n: string) => void props.delete(n)
      }
    }
  }
  const mk = (vars: Record<string, string>, fg: string): Theme => ({
    id: 't',
    name: 'T',
    kind: 'dark',
    vars,
    xterm: { foreground: fg }
  })

  it('sets variables, drops ones the next theme lacks, and tells terminals the new palette', () => {
    const root = fakeRoot()
    const seen: string[] = []
    const off = onXtermTheme((x) => seen.push(x.foreground ?? ''))
    applyTheme(mk({ '--a': '#111', '--b': '#222' }, '#aaa'), root)
    applyTheme(mk({ '--a': '#333' }, '#bbb'), root)
    expect([...root.props]).toEqual([['--a', '#333']])
    off()
    applyTheme(mk({}, '#ccc'), root)
    expect(seen).toEqual(['#aaa', '#bbb'])
    expect(currentXtermTheme()).toEqual({ foreground: '#ccc' })
  })

  it('keeps the whole theme for plugin frames and tells their listeners about each new one', () => {
    const root = fakeRoot()
    const seen: string[] = []
    const off = onTheme((t) => seen.push(t.vars['--a'] ?? ''))
    const first = mk({ '--a': '#111' }, '#aaa')
    applyTheme(first, root)
    expect(currentTheme()).toBe(first)
    off()
    applyTheme(mk({ '--a': '#222' }, '#bbb'), root)
    expect(seen).toEqual(['#111'])
    expect(currentTheme()?.vars).toEqual({ '--a': '#222' })
  })
})

describe('ThemeService', () => {
  function service(opts: { theme?: string; dark?: boolean } = {}): {
    svc: ThemeService
    settings: { data: { theme?: string }; saves: number; save(): void }
    changes: Theme[]
    os: { dark: boolean }
  } {
    const settings = {
      data: { theme: opts.theme },
      saves: 0,
      save() {
        this.saves++
      }
    }
    const changes: Theme[] = []
    const os = { dark: opts.dark ?? false }
    const svc = new ThemeService({ settings, isDark: () => os.dark, onChange: (t) => changes.push(t) })
    return { svc, settings, changes, os }
  }

  it('follows the OS until the user picks a theme', () => {
    const { svc, changes, os } = service({ dark: false })
    expect(svc.current().id).toBe('light')
    os.dark = true
    svc.refresh()
    expect(svc.current().id).toBe('dark')
    expect(changes.map((t) => t.id)).toEqual(['dark'])
    svc.refresh()
    expect(changes).toHaveLength(1) // unchanged: no rebroadcast
  })

  it('a picked theme ignores the OS and is saved', () => {
    const { svc, settings, changes, os } = service({ dark: true })
    svc.setActive('light')
    expect(settings.data.theme).toBe('light')
    expect(settings.saves).toBe(1)
    os.dark = false
    svc.refresh()
    os.dark = true
    svc.refresh()
    expect(svc.current().id).toBe('light')
    expect(changes.map((t) => t.id)).toEqual(['light'])
  })

  it('setActive(undefined) goes back to following the OS; unknown ids are refused', () => {
    const { svc, settings } = service({ theme: 'light', dark: true })
    expect(() => svc.setActive('nope')).toThrow(/unknown theme/)
    svc.setActive(undefined)
    expect('theme' in settings.data).toBe(false)
    expect(svc.current().id).toBe('dark')
  })

  it('a stored id naming a missing theme falls back to the OS built-in', () => {
    const { svc } = service({ theme: 'gone', dark: true })
    expect(svc.current().id).toBe('dark')
  })

  it('a contributed theme can be picked; unregistering the active one falls back, and it returns with the plugin', () => {
    const { svc, settings, changes } = service({ dark: false })
    svc.register(valid)
    expect(svc.list().map((t) => t.id)).toEqual(['light', 'dark', 'solar'])
    svc.setActive('solar')
    expect(svc.current().id).toBe('solar')

    svc.unregister('solar')
    expect(svc.current().id).toBe('light')
    expect(settings.data.theme).toBe('solar') // the pick is kept
    svc.register(valid)
    expect(svc.current().id).toBe('solar')
    expect(changes.map((t) => t.id)).toEqual(['solar', 'light', 'solar'])
  })

  it('registering a stored-but-missing theme switches to it', () => {
    const { svc, changes } = service({ theme: 'solar' })
    svc.register(valid)
    expect(changes.map((t) => t.id)).toEqual(['solar'])
  })

  it('a contributed theme inherits the shell variables it lacks from the built-in of its kind', () => {
    const { svc } = service()
    const dark = BUILTIN_THEMES.find((t) => t.id === 'dark')!
    const theme = svc.register(valid)
    // Its own values win; a token it predates (the accent) comes from the dark built-in.
    expect(theme.vars['--cc-bg']).toBe('#002b36')
    expect(theme.vars['--custom-thing']).toBe('rgb(1, 2, 3)')
    expect(theme.vars['--cc-accent']).toBe(dark.vars['--cc-accent'])
    expect(theme.vars['--cc-fg']).toBe(dark.vars['--cc-fg'])
    const light = svc.register({ ...valid, id: 'paper', kind: 'light' })
    expect(light.vars['--cc-accent']).toBe(BUILTIN_THEMES.find((t) => t.id === 'light')!.vars['--cc-accent'])
  })

  it('both built-ins define the same variables (a theme switch leaves none behind)', () => {
    const [a, b] = BUILTIN_THEMES.map((t) => Object.keys(t.vars).sort())
    expect(a).toEqual(b)
    for (const name of ['--cc-accent', '--cc-accent-fg', '--cc-accent-soft', '--cc-focus', '--cc-surface-1', '--cc-shadow']) {
      expect(a).toContain(name)
    }
  })

  describe('update (ctx.themes.set)', () => {
    const live = { name: 'Live', kind: 'dark', vars: { '--cc-bg': '#111111' }, xterm: { red: '#ff0000' } }

    it('replaces a registered theme in place, inheriting the base vars, keeping its name and list place', () => {
      const { svc, changes } = service()
      svc.register(valid)
      svc.register({ ...valid, id: 'other' })
      expect(svc.update('solar', { kind: 'light', vars: { '--cc-bg': '#fafafa' } })).toBe(true)
      const t = svc.list().find((x) => x.id === 'solar')!
      const light = BUILTIN_THEMES.find((x) => x.id === 'light')!
      expect(t).toMatchObject({ id: 'solar', name: 'Solar', kind: 'light', xterm: {} })
      expect(t.vars['--cc-bg']).toBe('#fafafa')
      // Inherited from the built-in of its new kind; the old theme's own variables are gone.
      expect(t.vars['--cc-accent']).toBe(light.vars['--cc-accent'])
      expect(t.vars['--custom-thing']).toBeUndefined()
      expect(svc.list().map((x) => x.id)).toEqual(['light', 'dark', 'solar', 'other'])
      // Not the shown theme: nothing to broadcast.
      expect(changes).toEqual([])
    })

    it('broadcasts when the updated theme is the active one, and an identical update is a no-op', () => {
      const { svc, changes } = service({ theme: 'solar' })
      svc.register(valid)
      expect(changes.map((t) => t.id)).toEqual(['solar'])
      expect(svc.update('solar', live)).toBe(true)
      expect(changes).toHaveLength(2)
      expect(changes[1]).toMatchObject({ id: 'solar', name: 'Live', xterm: { red: '#ff0000' } })
      expect(changes[1]!.vars['--cc-bg']).toBe('#111111')
      expect(svc.current()).toBe(changes[1])
      // N windows' hosts send the same update; key order does not matter either.
      expect(svc.update('solar', { ...live })).toBe(false)
      expect(svc.update('solar', { xterm: { red: '#ff0000' }, vars: { '--cc-bg': '#111111' }, kind: 'dark', name: 'Live' })).toBe(false)
      expect(changes).toHaveLength(2)
      expect(svc.update('solar', { ...live, vars: { '--cc-bg': '#222222' } })).toBe(true)
      expect(changes).toHaveLength(3)
    })

    it('ignores the id in the payload and refuses unknown ids, built-ins and invalid themes', () => {
      const { svc } = service()
      svc.register(valid)
      svc.register({ ...valid, id: 'other', name: 'Other' })
      svc.update('solar', { ...live, id: 'other' })
      expect(svc.list().find((x) => x.id === 'other')!.name).toBe('Other')
      expect(svc.list().find((x) => x.id === 'solar')!.name).toBe('Live')
      expect(() => svc.update('nope', live)).toThrow(/theme is not registered/)
      expect(() => svc.update('dark', live)).toThrow(/theme is not registered/)
      expect(() => svc.update('solar', { ...live, vars: { '--cc-bg': 'red; x' } })).toThrow(/invalid theme: vars: --cc-bg is not a colour/)
      expect(() => svc.update('solar', null)).toThrow(/invalid theme/)
      expect(() => svc.update('solar', { kind: 'sepia' })).toThrow(/invalid theme/)
      // A refused update leaves the theme as it was.
      expect(svc.list().find((x) => x.id === 'solar')!.name).toBe('Live')
    })

    it('an unregistered theme cannot be updated, and register after unregister takes the file again', () => {
      const { svc } = service()
      svc.register(valid)
      svc.update('solar', live)
      svc.unregister('solar')
      expect(() => svc.update('solar', live)).toThrow(/theme is not registered/)
      expect(svc.register(valid).name).toBe('Solar')
    })
  })

  it('refuses invalid themes and duplicate or built-in ids', () => {
    const { svc } = service()
    expect(() => svc.register({ ...valid, kind: 'x' })).toThrow(/invalid theme/)
    expect(() => svc.register({ ...valid, id: 'dark' })).toThrow(/already in use/)
    svc.register(valid)
    expect(() => svc.register(valid)).toThrow(/already in use/)
  })
})
