import { GUEST_SAFE_COMMANDS } from '../../shared/guest-class'
import type { ViewAccess } from '../../shared/views'

/** The owner's new-tab menu entries (shared/tab-commands.ts): the owner's own command lines, never a guest's. */
const TAB_COMMAND_PREFIX = 'tab.newCommand.'

/**
 * Whether a view of `access` may run command `id` (design-guests §10, spec-review 10 and 24). The owner
 * runs everything; a guest only the core commands GUEST_SAFE_COMMANDS lists for its role (navigation of
 * what it sees, plus New Claude and Shell tabs, Close and the overlay keys for a write guest), and a
 * plugin's commands (`<pluginId>/<command>`, the same slash rule as guest-class.ts byCommand) only as a
 * write guest. The [+] menu's entries are checked first: their ids hold no slash but are the owner's.
 * A UI hint: every command ends in a channel main checks against the view it bound (GUEST_CLASS).
 */
export function guestMayRun(id: string, access: ViewAccess = 'owner'): boolean {
  if (access === 'owner') return true
  if (id.startsWith(TAB_COMMAND_PREFIX)) return false
  if (id.includes('/')) return access === 'write'
  return GUEST_SAFE_COMMANDS[access].includes(id)
}

/** What is up in the shell that limits which commands may run. */
export interface ModalState {
  /** The close-tab confirmation dialog. */
  confirming: boolean
  paletteOpen: boolean
  overlayOpen: boolean
  settingsShown: boolean
  /** This view's access (shell-kind.ts viewAccessHint); absent: the owner. */
  access?: ViewAccess
}

/**
 * Whether a bound command may run now, given what is up. The one gate for keys typed into the
 * shell page and for chords main forwards from a webview panel's view (`commands.trigger`), so a
 * key typed into a web page can do no more than the same key typed here.
 */
export function commandAllowed(id: string, s: ModalState): boolean {
  // A guest's view runs only what its role may (guestMayRun), whatever is up.
  if (!guestMayRun(id, s.access)) return false
  // While the close dialog is up no command runs at all: Cmd+W again must not close a second
  // tab, nor Cmd+T open one, nor anything move the focus out of the dialog unanswered.
  if (s.confirming) return false
  // With the palette open only the palette chord (to toggle it shut) works: Cmd+W must not
  // close a tab, nor Cmd+T open one, behind the dialog.
  if (s.paletteOpen && id !== 'palette.open') return false
  // Likewise behind an overlay: only the overlay keys act until it is closed.
  if (s.overlayOpen && id !== 'overlay.pop' && id !== 'overlay.closeTop') return false
  // And behind the settings screen: its own chord toggles it, the overlay keys reach an
  // overlay opened over it (Esc inside the screen itself is handled by the screen).
  if (s.settingsShown && id !== 'app.openSettings' && id !== 'overlay.pop' && id !== 'overlay.closeTop') return false
  return true
}
