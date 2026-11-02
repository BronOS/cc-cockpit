// Application menu. Kept deliberately small. Menu accelerators win over the renderer's key handler,
// so the one item that has a chord takes it from the focused window's resolved key table (user
// overrides and that project's plugin commands included) instead of hard-coding it; `AppMenu`
// rebuilds the menu when that table or the focused window changes.
import { app, Menu, type MenuItemConstructorOptions } from 'electron'
import { own } from '../shared/guards'
import type { CommandsView } from '../shared/ipc'
import { splitChord } from '../shared/keys'

export interface MenuActions {
  /** Electron accelerator of File > Open Folder (from the resolved key table); none when unbound. */
  openFolderAccelerator?: string
  /** File > Open Folder: native folder dialog, then open or focus that project. */
  openFolder(): void
  /**
   * File > Open Project: the project picker (recent projects + Open Folder), or focus it. No
   * accelerator: none existed for the picker, and a new default chord could take one Claude or a
   * plugin uses; the top strip's "+" is the other way in.
   */
  openProject(): void
}

export function installMenu(actions: MenuActions): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate(actions, process.platform)))
}

export interface AppMenuOptions {
  /**
   * The project of the focused window, or '' for the picker or no focused window. `leaving` is a
   * window that is losing the focus (a blur): it counts as unfocused even if Electron still
   * reports it, so the order of blur and focus events does not matter.
   */
  focusedProjectId(leaving?: unknown): string
  /** The project's key table (`CommandRegistry.view`; '' gives the core commands only). */
  view(projectId: string): CommandsView
  openFolder(): void
  openProject(): void
  /** Installs the menu; `installMenu` unless a test replaces it. */
  install?(actions: MenuActions): void
}

/**
 * The application menu, kept in step with the focused window's key table. The menu is global but
 * keys are per project: a user override can give Cmd+O to a plugin command of one project (an
 * override outranks a core default in resolveKeys), and an accelerator taken from the core table
 * alone would keep intercepting Cmd+O in that window, opening the folder dialog instead of the
 * command the settings screen shows as bound. So the accelerator is resolved against the focused
 * project's own view; when Open Folder has no key there, the menu item has none, and the
 * renderer's key handler (which runs `app.openFolder` itself when it does own the chord) decides.
 * Call `refresh` on a focus change and on every change of keys or plugin commands.
 */
export class AppMenu {
  /** What is installed now; undefined until the first install. */
  private current: { accelerator: string | undefined } | undefined

  constructor(private readonly options: AppMenuOptions) {}

  refresh(leaving?: unknown): void {
    const projectId = this.options.focusedProjectId(leaving)
    const accelerator = openFolderAccelerator(this.options.view(projectId))
    // Focus changes are frequent and rebuilding the menu is not free; most leave the chord alone.
    if (this.current && this.current.accelerator === accelerator) return
    this.current = { accelerator }
    const install = this.options.install ?? installMenu
    install({
      ...(accelerator ? { openFolderAccelerator: accelerator } : {}),
      openFolder: () => this.options.openFolder(),
      openProject: () => this.options.openProject()
    })
  }
}

/** File > Open Folder's accelerator in a key table: only a chord that fires `app.openFolder`. */
export function openFolderAccelerator(view: CommandsView): string | undefined {
  return chordToAccelerator(view.commands.find((c) => c.id === 'app.openFolder')?.key)
}

/**
 * The canonical chord (`meta+o`) the picker shows on its Open Folder button: the one the menu
 * installs as the accelerator for that table, so the hint names exactly the key that works there.
 * The picker has no key handler of its own for it (a second one would open two dialogs).
 */
export function openFolderKey(view: CommandsView): string | undefined {
  const key = view.commands.find((c) => c.id === 'app.openFolder')?.key
  return chordToAccelerator(key) ? key : undefined
}

function menuTemplate(
  actions: MenuActions,
  platform: NodeJS.Platform
): MenuItemConstructorOptions[] {
  const mac = platform === 'darwin'
  // File and Window are built by hand instead of the `fileMenu` / `windowMenu` roles: those add a
  // `close` item bound to Cmd/Ctrl+W, and Cmd+W is "close tab" in this app (see the keybindings).
  // A menu accelerator would win over the renderer and close the whole window instead of a tab.
  const file: MenuItemConstructorOptions = {
    label: 'File',
    submenu: [
      {
        label: 'Open Project…',
        click: () => actions.openProject()
      },
      {
        label: 'Open Folder…',
        ...(actions.openFolderAccelerator ? { accelerator: actions.openFolderAccelerator } : {}),
        click: () => actions.openFolder()
      },
      ...(mac ? [] : [{ type: 'separator' as const }, { role: 'quit' as const }])
    ]
  }
  // The edit role carries the copy/paste/select-all accelerators; without them Cmd+C / Cmd+V do
  // nothing on macOS in xterm.js and in every text field (the browser relies on the menu there).
  const edit: MenuItemConstructorOptions = { role: 'editMenu' }
  const window: MenuItemConstructorOptions = {
    label: 'Window',
    role: 'window',
    submenu: [
      { role: 'minimize' },
      { role: 'zoom' },
      ...(mac ? [{ type: 'separator' as const }, { role: 'front' as const }] : [])
    ]
  }
  const template: MenuItemConstructorOptions[] = []
  if (mac) template.push({ role: 'appMenu' })
  template.push(file, edit)
  // Reload and devtools only in development: a reload in a shipped app would drop the renderer's
  // state (scrollback, panel state) for no benefit.
  if (!app.isPackaged) template.push({ role: 'viewMenu' })
  template.push(window)
  return template
}

const ACCELERATOR_KEYS: Record<string, string> = {
  escape: 'Escape',
  enter: 'Enter',
  tab: 'Tab',
  space: 'Space',
  backspace: 'Backspace',
  delete: 'Delete',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right'
}

/** A canonical chord (`shift+meta+o`) as an Electron accelerator (`Shift+Meta+O`), or undefined. */
export function chordToAccelerator(chord: string | undefined): string | undefined {
  if (!chord) return undefined
  // splitChord: '+' is also a key (`meta++`). Electron names it `Plus`; a literal '+' in an
  // accelerator is read as a separator.
  const parts = splitChord(chord)
  if (!parts) return undefined
  const mods = parts.mods.map((m) => m.charAt(0).toUpperCase() + m.slice(1))
  const named = parts.key === '+' ? 'Plus' : (own(ACCELERATOR_KEYS, parts.key) ?? parts.key.toUpperCase())
  return [...mods, named].join('+')
}
