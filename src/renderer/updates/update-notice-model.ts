// What the update bar says, as plain data (plan: distribution, Task 5). Every string is written
// here; the only thing taken from main is a version it validated as `x.y.z`, and it is shown as
// a React text node, never as markup. Kept out of the component so a unit test covers each platform.
import type { UpdateState } from '../../shared/ipc'

export type UpdatePlatform = 'mac' | 'other'

export interface UpdateNoticeModel {
  /** The version on show, which Dismiss names to main. */
  version: string
  heading: string
  /** The command to run (mac, Homebrew), or null where the user downloads from the release page. */
  command: string | null
  /** Text before the release link. */
  action: string
  linkLabel: string
  note: string
}

export const QUIT_FIRST_NOTE = 'Quit cc-cockpit before upgrading, or restart it afterwards.'

export function updateNoticeModel(state: UpdateState | null, platform: UpdatePlatform): UpdateNoticeModel | null {
  if (!state?.available) return null
  const version = state.available.version
  const heading = `cc-cockpit ${version} is available (you have ${state.current}).`
  if (platform === 'mac') {
    return { version, heading, command: 'brew update && brew upgrade --cask cc-cockpit', action: 'Upgrade with', linkLabel: 'Release notes', note: QUIT_FIRST_NOTE }
  }
  return { version, heading, command: null, action: 'Download the new version from the release page.', linkLabel: 'Open release page', note: QUIT_FIRST_NOTE }
}

/** Shown when main could not open the release page (no browser handler, say): says what to do instead. */
export function openReleaseFailureText(reason: string): string {
  return `Could not open the release page (${reason}). Find the release on the cc-cockpit GitHub releases page.`
}

/**
 * The initial `updates.state` reply can arrive after an `updates.changed` event; the event is newer, so
 * once one has come the reply is dropped (else it could hide an update the event just announced).
 */
export function newestUpdateState(): { fromEvent(s: UpdateState): UpdateState; fromReply(s: UpdateState): UpdateState | null } {
  let sawEvent = false
  return {
    fromEvent: (s) => { sawEvent = true; return s },
    fromReply: (s) => (sawEvent ? null : s),
  }
}
