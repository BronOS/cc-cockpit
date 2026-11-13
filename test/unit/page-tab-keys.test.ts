// Keyboard routing for page tabs (design-editor.md §1 "Keyboard", plan Task 3). Desktop: main sees a
// page tab frame's keys first (before-input-event) and sends the app's chords to the shell
// (page-tab-keys.ts). Web shell: the shell lists the app's chords with the page tab intro, the panel
// SDK forwards those (panel-core.ts keyDown), and the pool hands a chord on only from the focused,
// shown frame (page-frames.ts). Precedence: the app table and the person's overrides win; a page's
// declared keys clash only in Settings › Keybindings (CommandRegistry.bindings pageKeys).
import { afterEach, describe, expect, it } from 'vitest'
import { CommandRegistry } from '../../src/main/commands/command-registry'
import { isPageTabFrame, pageTabChord } from '../../src/main/tabs/page-tab-keys'
import {
  forwardedChords,
  onKeyTable,
  registerHandlers,
  resetKeybindings,
  runForwardedChord,
  setCommands,
  setForwardedRunner,
  captureKeys
} from '../../src/renderer/commands/keybindings'
import { chordOfKey, PanelClient, TAB_KEY_MESSAGE, TAB_MESSAGE, type KeyLike, type ThemeRoot } from '../../src/sdk/panel-core'
import { chordFromEvent } from '../../src/shared/keys'
import { PAGE_TAB_FRAME_NAME } from '../../src/shared/page-tabs'
import { entry, pool, settle, TAB_A, TAB_B } from '../fakes/fake-page-frames'

afterEach(() => resetKeybindings())

const key = (k: string, code: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  key: k,
  code,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...mods
})

describe('desktop: before-input-event on a page tab frame', () => {
  const frame = { name: PAGE_TAB_FRAME_NAME, url: 'cc-plugin://cockpit.editor/page/file.html', parent: {} }

  it('is a page tab frame only as a named cc-plugin child frame', () => {
    expect(isPageTabFrame(frame)).toBe(true)
    expect(isPageTabFrame({ ...frame, parent: null })).toBe(false)
    expect(isPageTabFrame({ ...frame, name: '' })).toBe(false)
    expect(isPageTabFrame({ ...frame, url: 'https://example.com/' })).toBe(false)
    expect(isPageTabFrame(null)).toBe(false)
  })

  it('the app table wins: its chords go to the shell, the rest (declared keys, typing, Escape) to the page', () => {
    const table: Record<string, string> = { 'ctrl+w': 'tab.close', 'ctrl+tab': 'tab.switchNext', escape: 'overlay.pop', 'ctrl+shift+w': 'overlay.closeTop' }
    const triggered: Array<[number, string]> = []
    const deps = {
      commandFor: (_w: number, c: string) => table[c],
      trigger: (w: number, id: string) => {
        triggered.push([w, id])
        return true
      }
    }
    expect(pageTabChord(deps, 3, 'ctrl+w')).toBe(true)
    expect(pageTabChord(deps, 3, 'ctrl+tab')).toBe(true)
    // The editor's own Ctrl+S, not in the table: the page's.
    expect(pageTabChord(deps, 3, 'ctrl+s')).toBe(false)
    expect(pageTabChord(deps, 3, 'escape')).toBe(false)
    expect(pageTabChord(deps, 3, 'ctrl+shift+w')).toBe(false)
    expect(pageTabChord(deps, 3, null)).toBe(false)
    // An auto-repeat of an app chord is swallowed and not run again; one that is no app chord is the page's.
    const before = triggered.length
    expect(pageTabChord(deps, 3, 'ctrl+w', true)).toBe(true)
    expect(pageTabChord(deps, 3, 'ctrl+s', true)).toBe(false)
    expect(triggered).toHaveLength(before)
    expect(triggered).toEqual([
      [3, 'tab.close'],
      [3, 'tab.switchNext']
    ])
  })

  it('a window that is gone takes nothing', () => {
    expect(pageTabChord({ commandFor: () => 'tab.close', trigger: () => false }, 3, 'ctrl+w')).toBe(false)
  })
})

describe('Settings › Keybindings: a page tab key the app table holds is shown as a clash', () => {
  it('names the page tab kinds on the row of the command that holds the chord, after overrides', () => {
    const reg = new CommandRegistry(
      'linux',
      () => ({ 'zone.toggleLeft': 'Ctrl+K' }),
      () => ({ app: [], project: [] }),
      () => [{ label: 'Editor file tabs', keys: ['Cmd+P', 'Ctrl+K', 'Ctrl+S', 'not a chord'] }]
    )
    const rows = reg.bindings('p')
    // Cmd+P is Ctrl+P on Linux; no app command holds it by default.
    expect(rows.filter((r) => r.pageKeys).map((r) => [r.id, r.key, r.pageKeys])).toEqual([['zone.toggleLeft', 'ctrl+k', ['Editor file tabs']]])
    // An override moving the command off the chord ends the clash.
    expect(reg.bindings('p', {}).some((r) => r.pageKeys)).toBe(false)
  })

  it('the table itself never changes for page tab keys', () => {
    const reg = new CommandRegistry('linux', () => ({}), undefined, () => [{ label: 'X tabs', keys: ['Cmd+W'] }])
    expect(reg.view('p').commands.find((c) => c.id === 'tab.close')?.key).toBe('ctrl+w')
  })
})

describe('web shell: the SDK forwards the chords the shell listed', () => {
  const root = (): ThemeRoot => ({ setProperty: () => {}, removeProperty: () => undefined, colorScheme: '' })
  function client() {
    const sent: unknown[] = []
    const c = new PanelClient(root(), () => {}, undefined, undefined, (m) => sent.push(m))
    return { c, sent }
  }

  it('writes chords the way the shell does', () => {
    const samples: KeyLike[] = [
      key('w', 'KeyW', { ctrlKey: true, altKey: true }),
      key('∑', 'KeyW', { metaKey: true, altKey: true }),
      key('Tab', 'Tab', { ctrlKey: true, shiftKey: true }),
      key('<', 'Comma', { metaKey: true, shiftKey: true }),
      key('!', 'Digit1', { ctrlKey: true, shiftKey: true }),
      key('е', 'KeyT', { ctrlKey: true }),
      key('ArrowUp', 'ArrowUp', { altKey: true }),
      key('Control', 'ControlLeft', { ctrlKey: true })
    ]
    for (const e of samples) expect(chordOfKey(e)).toBe(chordFromEvent(e))
  })

  it('stops and forwards a listed chord, leaves the rest to the page, and sends no repeat', () => {
    const { c, sent } = client()
    // Not a page tab yet, or no list (the desktop): nothing is taken.
    expect(c.keyDown(key('w', 'KeyW', { ctrlKey: true, altKey: true }))).toBe(false)
    c.receive({ type: TAB_MESSAGE, tab: { type: 'file' } }, [])
    expect(c.keyDown(key('w', 'KeyW', { ctrlKey: true, altKey: true }))).toBe(false)
    c.receive({ type: TAB_MESSAGE, tab: { type: 'file' }, keys: ['ctrl+alt+w', 'ctrl+alt+tab', 42] }, [])
    expect(c.keyDown(key('w', 'KeyW', { ctrlKey: true, altKey: true }))).toBe(true)
    expect(c.keyDown(key('s', 'KeyS', { ctrlKey: true }))).toBe(false)
    expect(c.keyDown(key('Tab', 'Tab', { ctrlKey: true, altKey: true, repeat: true }))).toBe(true)
    expect(sent).toEqual([{ type: TAB_KEY_MESSAGE, chord: 'ctrl+alt+w' }])
    // A new table replaces the list.
    c.receive({ type: TAB_MESSAGE, tab: { type: 'other' }, keys: ['ctrl+s'] }, [])
    expect(c.api.tab?.type).toBe('file')
    expect(c.keyDown(key('w', 'KeyW', { ctrlKey: true, altKey: true }))).toBe(false)
    expect(c.keyDown(key('s', 'KeyS', { ctrlKey: true }))).toBe(true)
  })
})

describe('web shell: the pool and the key table', () => {
  it("the intro carries the shell's chord list; a new table is posted to every served page", async () => {
    let keys: string[] | undefined = ['ctrl+alt+w']
    const t = pool({ keys: () => keys })
    t.frames.sync([entry(TAB_A)])
    t.frames.show(TAB_A)
    await settle()
    t.el(TAB_A).fire()
    t.connects.at(-1)!.deliver(t.port())
    expect(t.el(TAB_A).sent).toContainEqual({ type: TAB_MESSAGE, tab: { type: 'file' }, keys: ['ctrl+alt+w'] })
    keys = ['ctrl+alt+t']
    t.frames.keysChanged()
    expect(t.el(TAB_A).sent.at(-1)).toEqual({ type: TAB_MESSAGE, tab: { type: 'file' }, keys: ['ctrl+alt+t'] })
    // The desktop lists none: the intro has no keys.
    const d = pool()
    d.frames.sync([entry(TAB_A)])
    d.frames.show(TAB_A)
    await settle()
    d.el(TAB_A).fire()
    d.connects.at(-1)!.deliver(d.port())
    expect(d.el(TAB_A).sent).toContainEqual({ type: TAB_MESSAGE, tab: { type: 'file' } })
  })

  it('a forwarded chord counts only from the shown frame with the keyboard, and only a listed one', async () => {
    const chords: string[] = []
    const t = pool({ keys: () => ['ctrl+alt+w'], chord: (c) => chords.push(c), userActive: () => true })
    t.frames.sync([entry(TAB_A), entry(TAB_B)])
    t.frames.show(TAB_A)
    await settle()
    t.frames.show(TAB_B)
    await settle()
    const a = t.el(TAB_A)
    const b = t.el(TAB_B)
    a.focusedNow = true
    a.fromPage({ type: TAB_KEY_MESSAGE, chord: 'ctrl+alt+w' })
    b.fromPage({ type: TAB_KEY_MESSAGE, chord: 'ctrl+alt+w' })
    expect(chords).toEqual([])
    b.focusedNow = true
    b.fromPage({ type: TAB_KEY_MESSAGE, chord: 'ctrl+t' })
    b.fromPage({ type: TAB_KEY_MESSAGE, chord: 'ctrl+alt+w' })
    expect(chords).toEqual(['ctrl+alt+w'])
  })

  it('a forwarded chord counts only while the browser says the person just gave real input (a script alone cannot run app commands)', async () => {
    const chords: string[] = []
    let active = false
    const t = pool({ keys: () => ['ctrl+alt+w'], chord: (c) => chords.push(c), userActive: () => active })
    t.frames.sync([entry(TAB_A)])
    t.frames.show(TAB_A)
    await settle()
    const a = t.el(TAB_A)
    a.focusedNow = true
    // The page's script posts the chord with no key pressed: nothing runs, however often.
    for (let i = 0; i < 5; i++) a.fromPage({ type: TAB_KEY_MESSAGE, chord: 'ctrl+alt+w' })
    expect(chords).toEqual([])
    active = true
    a.fromPage({ type: TAB_KEY_MESSAGE, chord: 'ctrl+alt+w' })
    expect(chords).toEqual(['ctrl+alt+w'])
    // No way to tell (an option left out): none taken.
    const none: string[] = []
    const u = pool({ keys: () => ['ctrl+alt+w'], chord: (c) => none.push(c) })
    u.frames.sync([entry(TAB_A)])
    u.frames.show(TAB_A)
    await settle()
    u.el(TAB_A).focusedNow = true
    u.el(TAB_A).fromPage({ type: TAB_KEY_MESSAGE, chord: 'ctrl+alt+w' })
    expect(none).toEqual([])
  })

  it('the shell lists every app chord with Cmd, Ctrl or Alt, not the overlay keys, and runs one through its runner', () => {
    setCommands({
      commands: [
        { id: 'tab.close', title: 'Close', key: 'ctrl+w', source: 'core' },
        { id: 'overlay.pop', title: 'Pop', key: 'escape', source: 'core' },
        { id: 'overlay.closeTop', title: 'Close top', key: 'ctrl+shift+w', source: 'core' },
        { id: 'x.f5', title: 'F5', key: 'f5', source: 'core' },
        { id: 'zone.toggleLeft', title: 'Left', key: 'alt+b', source: 'core' }
      ],
      conflicts: []
    })
    expect(forwardedChords().sort()).toEqual(['alt+b', 'ctrl+w'])
    const ran: string[] = []
    // No runner, or no handler for the command: nothing runs.
    expect(runForwardedChord('ctrl+w')).toBe(false)
    const off = setForwardedRunner((id) => ran.push(id))
    expect(runForwardedChord('ctrl+w')).toBe(false)
    registerHandlers({ 'tab.close': () => {} })
    expect(runForwardedChord('ctrl+w')).toBe(true)
    expect(runForwardedChord('ctrl+q')).toBe(false)
    // The keybinding editor recording: no chord runs anything.
    const release = captureKeys()
    expect(runForwardedChord('ctrl+w')).toBe(false)
    release()
    off()
    expect(runForwardedChord('ctrl+w')).toBe(false)
    expect(ran).toEqual(['tab.close'])
  })

  it('a new key table is told to its listeners', () => {
    let told = 0
    const off = onKeyTable(() => told++)
    setCommands({ commands: [], conflicts: [] })
    off()
    setCommands({ commands: [], conflicts: [] })
    expect(told).toBe(1)
  })
})
