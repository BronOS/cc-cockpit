// The appearance and general pages of the settings overlay (design §6): the app-wide theme, the
// keybinding overrides, what a tab does when its process exits (`tabExit`) and whether a project
// that opens empty gets a Claude tab (`claudeTabOnOpen`), whether Haiku writes a gist of each Claude
// session (`sessionGist`, main/sessions/session-gist.ts), whether a plugin notification with `sound`
// chimes (`notificationSounds`, main/notifications/notifier.ts ChimeGate) and with which sound
// (`notificationSound`, shared/notify-sound.ts; system files in main/notifications/system-sounds.ts), whether closing a running tab asks first
// (`confirmTabClose`), which end of a tab its close button sits at (`tabCloseSide`), whether the side
// zones give way to a narrow terminal (`zoneAutoHide`, `minTerminalWidth`), the terminals'
// font (`terminalFont`; checks in terminal-font.ts), the see-through window background
// (`windowBackground`; checks in window-background.ts), and shows the app-wide new-tab menu entries
// (`tabCommands`; saved by TabCommandsService, main/tabs/tab-commands.ts). Plain TypeScript over injected pieces; the router passes the asking
// window's project (a plugin command exists per project) and main validates every input.
//
// Decisions:
//  - A conflict is allowed, not refused: the list shows who clashes and who is inactive (the
//    resolution rules are shared/keys.ts `resolveKeys`: user override > core default > plugin
//    default, a tie binds nobody). Refusing would make it impossible to swap two keys through an
//    intermediate state. One exception: a change that leaves neither "Open Settings" nor the
//    command palette with a working chord is refused. They are the only ways into this screen
//    (there is no menu item), so after it the only fix would be editing `app.json` by hand.
//  - `normalizeChord` refuses a chord without a modifier, Shift alone included (a bare letter or
//    Shift+K would swallow typing in the terminal), except Escape and function keys. On top of
//    that the terminal's signal keys are refused (TERMINAL_CHORDS): the window's key handler takes
//    a bound chord before xterm sees it, so binding Ctrl+C would silently end SIGINT in every tab.
//  - Only the canonical chord is stored, and an override equal to the default is dropped, so
//    `app.json` holds only real changes, unless the override is what makes the command win its
//    own default chord (a plugin default that loses to a core default or ties with another
//    plugin's: user override > core default > plugin default). '' (unbound) is stored as is.
//  - Overrides are keyed by commands main knows for the asking project; a payload cannot add an
//    entry for an arbitrary id.
import { checkDiscussPrompt, discussPromptOf } from '../../shared/discuss'
import { own } from '../../shared/guards'
import type { AppearanceView, KeyBindingRow, ShellPrefs } from '../../shared/ipc'
import { normalizeChord, type KeyPlatform } from '../../shared/keys'
import { notificationSoundOf, parseSoundId } from '../../shared/notify-sound'
import type { Theme } from '../../shared/theme'
import type { TerminalFont } from '../../shared/terminal-font'
import type { TabCloseSide, TabExitBehavior } from '../../shared/types'
import type { BlurSupport, WindowBackground } from '../../shared/window-background'
import { MIN_TERMINAL_WIDTH_RANGE, minTerminalWidthOf, zoneAutoHideOf } from '../../shared/zone-auto-hide'
import type { CommandRegistry } from '../commands/command-registry'
import { tabCommandsOf } from '../tabs/tab-commands'
import { storedTerminalFontFields, terminalFontOf, terminalFontPatchOf } from './terminal-font'
import { storedWindowBackgroundFields, windowBackgroundOf, windowBackgroundPatchOf } from './window-background'

/** Chords the terminal needs (macOS leaves Ctrl free, so these are SIGINT, EOF and SIGTSTP there; on Linux Cmd+C is the same chord). */
const TERMINAL_CHORDS: Readonly<Record<string, string>> = {
  'ctrl+c': 'interrupt',
  'ctrl+d': 'end of input',
  'ctrl+z': 'suspend'
}

/** The commands that open the settings screen (the palette lists "Open Settings"). */
const WAYS_IN = ['app.openSettings', 'palette.open']

export interface AppearanceDeps {
  themes: {
    list(): Theme[]
    current(): Theme
    selected(): string | undefined
    setActive(id: string | undefined): void
  }
  commands: Pick<CommandRegistry, 'bindings' | 'has'>
  platform: KeyPlatform
  /** `app.json` › `keyOverrides`, as stored (unvalidated) and replaced as a whole. */
  overrides: { get(): unknown; set(next: Record<string, string>): void }
  /** The key table changed: tell every project window (`commands.updated`). */
  keysChanged(): void
  /**
   * `app.json` › `tabExit`, as stored (unvalidated). TabManager reads it at each exit, so a change
   * applies to the tabs already open without telling anyone.
   */
  tabExit: { get(): unknown; set(next: TabExitBehavior): void }
  /**
   * `app.json` › `claudeTabOnOpen`, as stored (unvalidated). Read when a project window first
   * attaches (main/tabs/first-tab.ts), so a change applies to the next window that opens.
   */
  claudeTabOnOpen: { get(): unknown; set(next: boolean): void }
  /** `app.json` › `sessionGist`, as stored (unvalidated). */
  sessionGist: { get(): unknown; set(next: boolean): void }
  /** `app.json` › `discussPrompt`, as stored (unvalidated). */
  discussPrompt: { get(): unknown; set(next: string): void }
  /** The session gist was turned on or off: start or cancel runs, remove the gists (SessionGist.settingChanged). */
  sessionGistChanged(): void
  /** `app.json` › `notificationSounds`, as stored (unvalidated). Read at each chime, so it needs no event. */
  notificationSounds: { get(): unknown; set(next: boolean): void }
  /**
   * `app.json` › `notificationSound`, as stored (unvalidated), and whether a system id is in a
   * fresh listing of the OS sound folders now (SystemSounds.has). Read at each chime: no event.
   */
  notificationSound: { get(): unknown; set(next: string): void; systemHas(id: string): Promise<boolean> }
  /**
   * `app.json` › `zoneAutoHide` and `minTerminalWidth`, as stored (unvalidated). Each window decides
   * from them as it lays out its zones, so a change is pushed to every window (`prefsChanged`).
   */
  zoneAutoHide: { get(): unknown; set(next: boolean): void }
  minTerminalWidth: { get(): unknown; set(next: number): void }
  /**
   * `app.json` › `confirmTabClose`, as stored (unvalidated). The renderer reads it at each close a
   * user starts (`settings.confirmTabClose`), so a change applies to the next close in any window.
   */
  confirmTabClose: { get(): unknown; set(next: boolean): void }
  /**
   * `app.json` › `tabCloseSide`, as stored (unvalidated). The tab strip draws from it as it renders,
   * so a change is pushed to every window (`prefsChanged`).
   */
  tabCloseSide: { get(): unknown; set(next: TabCloseSide): void }
  /**
   * `app.json` › `terminalFont`, as stored (unvalidated); undefined removes it (the defaults). Every
   * terminal applies it as it changes, so a change is pushed like `tabCloseSide`.
   */
  terminalFont: { get(): unknown; set(next: Partial<TerminalFont> | undefined): void }
  /**
   * A setting in ShellPrefs changed: send `prefs()` to every window (`prefs.changed`), which apply
   * it to what is on screen now (the tab strip, every terminal).
   */
  prefsChanged(): void
  /** `app.json` › `tabCommands`, as stored (unvalidated; tabCommandsOf drops bad entries). */
  tabCommands: { get(): unknown }
  /**
   * `app.json` › `windowBackground`, as stored (unvalidated). `transparent` is read by the window
   * manager at each project window's creation (main/index.ts), so it needs no event.
   */
  windowBackground: { get(): unknown; set(next: Partial<WindowBackground>): void }
  /** What "Blur behind" does on this platform (window-chrome.ts `blurSupport`). */
  blurSupport: BlurSupport
  /** "Blur behind" changed: apply it to the open windows created transparent (WindowManager.setBlur). */
  blurChanged(on: boolean): void
}

/** The stored `tabExit`, default applied: anything but 'keep' closes on a clean exit. */
export function tabExitOf(stored: unknown): TabExitBehavior {
  return stored === 'keep' ? 'keep' : 'close-clean'
}

/**
 * The stored `claudeTabOnOpen`, default applied: only an explicit `false` turns it off. A damaged
 * value (`"no"`, 0) reads as the default rather than as off, like `tabExitOf`.
 */
export function claudeTabOnOpenOf(stored: unknown): boolean {
  return stored !== false
}

/**
 * The stored `sessionGist`, default applied: only an explicit `true` turns it on. The other way round
 * from `claudeTabOnOpenOf`: a damaged value must not start spending the person's Claude usage.
 */
export function sessionGistOf(stored: unknown): boolean {
  return stored === true
}

/**
 * The stored `notificationSounds`, default applied: only an explicit `false` turns it off. A plugin
 * asks for the sound per notification (a reminder), so on is what the plugin author expects.
 */
export function notificationSoundsOf(stored: unknown): boolean {
  return stored !== false
}

/**
 * The stored `confirmTabClose`, default applied: only an explicit `false` turns it off. A damaged
 * value reads as on: the cost of a wrong "on" is one extra click, of a wrong "off" a killed task.
 */
export function confirmTabCloseOf(stored: unknown): boolean {
  return stored !== false
}

/**
 * The stored `tabCloseSide`, default applied: only 'left' moves the button; anything else (absent,
 * damaged) is 'right', where it was before the setting existed.
 */
export function tabCloseSideOf(stored: unknown): TabCloseSide {
  return stored === 'left' ? 'left' : 'right'
}

export class AppearanceService {
  constructor(private readonly deps: AppearanceDeps) {}

  view(projectId: string): AppearanceView {
    return {
      themes: this.deps.themes.list().map((t) => ({ id: t.id, name: t.name, kind: t.kind })),
      selected: this.deps.themes.selected() ?? null,
      current: this.deps.themes.current().id,
      keys: this.deps.commands.bindings(projectId),
      tabExit: tabExitOf(this.deps.tabExit.get()),
      claudeTabOnOpen: claudeTabOnOpenOf(this.deps.claudeTabOnOpen.get()),
      sessionGist: sessionGistOf(this.deps.sessionGist.get()),
      discussPrompt: discussPromptOf(this.deps.discussPrompt.get()) ?? '',
      notificationSounds: notificationSoundsOf(this.deps.notificationSounds.get()),
      notificationSound: notificationSoundOf(this.deps.notificationSound.get()),
      zoneAutoHide: zoneAutoHideOf(this.deps.zoneAutoHide.get()),
      minTerminalWidth: minTerminalWidthOf(this.deps.minTerminalWidth.get()),
      confirmTabClose: this.confirmTabClose(),
      tabCloseSide: tabCloseSideOf(this.deps.tabCloseSide.get()),
      terminalFont: terminalFontOf(this.deps.terminalFont.get()),
      windowBackground: this.windowBackground(),
      blurSupport: this.deps.blurSupport,
      tabCommands: tabCommandsOf(this.deps.tabCommands.get())
    }
  }

  /** The window background setting, defaults applied (what a new project window is made with). */
  windowBackground(): WindowBackground {
    return windowBackgroundOf(this.deps.windowBackground.get())
  }

  /**
   * Change some fields of the window background. Merged into the good stored fields like the
   * terminal font. Each field reaches what it can: a new opacity every window (`prefs.changed`; a
   * window main made opaque ignores it), a new blur the windows created transparent, a new
   * `transparent` nothing open (Electron cannot change it on a live window, and recreating one would
   * end its terminals and Claude sessions): the next project window is made with it.
   */
  setWindowBackground(value: unknown): void {
    const patch = windowBackgroundPatchOf(value)
    const before = this.windowBackground()
    this.deps.windowBackground.set({ ...storedWindowBackgroundFields(this.deps.windowBackground.get()), ...patch })
    const after = this.windowBackground()
    if (after.opacity !== before.opacity || after.area !== before.area) this.deps.prefsChanged()
    if (after.blur !== before.blur) this.deps.blurChanged(after.blur)
  }

  /** Close a tab on a clean exit ('close-clean') or keep every exited tab ('keep'). */
  setTabExit(value: unknown): void {
    if (value !== 'close-clean' && value !== 'keep') throw new Error("give 'close-clean' or 'keep'")
    this.deps.tabExit.set(value)
  }

  /** Open a Claude tab when a project window opens with no tabs (true), or leave it empty. */
  setClaudeTabOnOpen(value: unknown): void {
    if (typeof value !== 'boolean') throw new Error('give true or false')
    this.deps.claudeTabOnOpen.set(value)
  }

  /** Turn the session gist on or off; the scheduler hears it at once (off cancels and hides). */
  setSessionGist(value: unknown): void {
    if (typeof value !== 'boolean') throw new Error('give true or false')
    const before = sessionGistOf(this.deps.sessionGist.get())
    this.deps.sessionGist.set(value)
    if (before !== value) this.deps.sessionGistChanged()
  }

  /** Save the global Discuss prompt, checked strictly (text within the cap); nothing is stored on a refusal. */
  setDiscussPrompt(value: unknown): void {
    this.deps.discussPrompt.set(checkDiscussPrompt(value))
  }

  /** Let plugin notifications with `sound` chime (true), or never; the next chime reads it. */
  setNotificationSounds(value: unknown): void {
    if (typeof value !== 'boolean') throw new Error('give true or false')
    this.deps.notificationSounds.set(value)
  }

  /**
   * Pick the sound of every notification with `sound`: a built-in tone, or a system sound that is
   * in main's listing right now (the renderer's id is a claim, like any payload). The next chime reads it.
   */
  async setNotificationSound(value: unknown): Promise<void> {
    const parsed = parseSoundId(value)
    if (!parsed) throw new Error('not a notification sound')
    if (parsed.kind === 'system' && !(await this.deps.notificationSound.systemHas(value as string))) {
      throw new Error('that sound file is no longer there')
    }
    this.deps.notificationSound.set(value as string)
  }

  /** Hide the side zones when the terminal gets narrow (true), or never; every window follows. */
  setZoneAutoHide(value: unknown): void {
    if (typeof value !== 'boolean') throw new Error('give true or false')
    this.deps.zoneAutoHide.set(value)
    this.deps.prefsChanged()
  }

  /** The terminal's minimum width (px) below which a side zone gives way; every window follows. */
  setMinTerminalWidth(value: unknown): void {
    const { min, max } = MIN_TERMINAL_WIDTH_RANGE
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      throw new Error(`give a whole number from ${min} to ${max}`)
    }
    this.deps.minTerminalWidth.set(value)
    this.deps.prefsChanged()
  }

  /** Whether closing a running tab asks first (default applied). */
  confirmTabClose(): boolean {
    return confirmTabCloseOf(this.deps.confirmTabClose.get())
  }

  /** Ask before closing a running tab (true), or close it at once. */
  setConfirmTabClose(value: unknown): void {
    if (typeof value !== 'boolean') throw new Error('give true or false')
    this.deps.confirmTabClose.set(value)
  }

  /** The settings the shell page applies itself (`prefs.get`), defaults applied. */
  prefs(): ShellPrefs {
    return {
      tabCloseSide: tabCloseSideOf(this.deps.tabCloseSide.get()),
      zoneAutoHide: zoneAutoHideOf(this.deps.zoneAutoHide.get()),
      minTerminalWidth: minTerminalWidthOf(this.deps.minTerminalWidth.get()),
      terminalFont: terminalFontOf(this.deps.terminalFont.get()),
      backgroundOpacity: this.windowBackground().opacity,
      seeThroughArea: this.windowBackground().area
    }
  }

  /** Put each tab's close button before its label ('left') or after it ('right'); every window follows. */
  setTabCloseSide(value: unknown): void {
    if (value !== 'left' && value !== 'right') throw new Error("give 'left' or 'right'")
    this.deps.tabCloseSide.set(value)
    this.deps.prefsChanged()
  }

  /**
   * Change some fields of the terminal font, or go back to the defaults (null). The change is
   * merged into the fields the user set before (damaged ones dropped, so app.json never keeps a
   * damaged field next to a fresh one). Only set fields are stored, never the defaults: a field
   * left alone follows the app's default, so changing the size does not pin today's default
   * family (the bundled font replaced Menlo that way, LEGACY_DEFAULT_FAMILY).
   */
  setTerminalFont(value: unknown): void {
    if (value === null) {
      this.deps.terminalFont.set(undefined)
    } else {
      const patch = terminalFontPatchOf(value)
      this.deps.terminalFont.set({ ...storedTerminalFontFields(this.deps.terminalFont.get()), ...patch })
    }
    this.deps.prefsChanged()
  }

  /** Pick a theme; null follows the OS. An unknown id is refused (ThemeService). */
  setTheme(id: unknown): void {
    if (id !== null && typeof id !== 'string') throw new Error('give a theme id, or null to follow the OS')
    this.deps.themes.setActive(id === null ? undefined : id)
  }

  /** Override one command's key (see `settings.keySet`). */
  setKey(projectId: string, commandId: unknown, chord: unknown): void {
    if (typeof commandId !== 'string' || !this.deps.commands.has(projectId, commandId)) {
      throw new Error('unknown command')
    }
    if (chord !== null && typeof chord !== 'string') throw new Error('give a key combination, "" to unbind, or null for the default')
    let next = this.stored()
    if (chord === null) {
      delete next[commandId]
    } else if (chord === '') {
      next[commandId] = ''
    } else {
      const canonical = normalizeChord(chord, this.deps.platform)
      if (!canonical) {
        throw new Error(`"${chord.slice(0, 40)}" is not a key combination (use a modifier other than Shift, e.g. Cmd+Shift+K)`)
      }
      const reserved = own(TERMINAL_CHORDS, canonical)
      if (reserved) throw new Error(`${canonical} is the terminal's ${reserved} key; pick another`)
      next[commandId] = canonical
      const row = this.row(projectId, next, commandId)
      if (row?.defaultKey === canonical) {
        const without = { ...next }
        delete without[commandId]
        // Kept only when it is load-bearing: with it the command fires, without it it would not.
        if (row.inactive || this.row(projectId, without, commandId)?.inactive !== true) next = without
      }
    }
    const rows = this.deps.commands.bindings(projectId, next)
    if (!rows.some((r) => WAYS_IN.includes(r.id) && r.key !== undefined && !r.inactive)) {
      throw new Error('this would leave no key for Open Settings or the Command Palette; give one of them a key first')
    }
    this.deps.overrides.set(next)
    this.deps.keysChanged()
  }

  private row(projectId: string, overrides: Record<string, string>, commandId: string): KeyBindingRow | undefined {
    return this.deps.commands.bindings(projectId, overrides).find((r) => r.id === commandId)
  }

  /** The stored overrides that are shaped right (a damaged entry is dropped, as resolveKeys ignores it). */
  private stored(): Record<string, string> {
    const raw = this.deps.overrides.get()
    const out: Record<string, string> = {}
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out
    for (const [id, value] of Object.entries(raw)) if (typeof value === 'string') out[id] = value
    return out
  }
}
