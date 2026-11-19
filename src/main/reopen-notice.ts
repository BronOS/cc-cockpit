// The reopen notice (plan 20261119-server-mode-mac, decision 3): on macOS a person who opens the
// server's app again (Finder, `open -a`, the Dock) sends `activate` to the running server. Without an
// answer it would seem to do nothing, so the server shows the second-launch box (second-launch.ts)
// with Stop and Cancel. The one named exception to `serverDialogs`: nobody is at a server's screen,
// except this gesture, and it is reached only from `activate`, through the dialog adapter.
//
// LaunchServices turns the process from UIElement into Foreground on that reopen and its Dock icon
// stays (design-web.md §9.15, S3), so the accessory policy is applied again once the box is answered
// and when an `activate` arrives while one is up. Pure Node (no Electron value import): the box, the
// focus, the policy and the quit are passed in, so unit tests load this file in plain Node.
import type { MessageBoxOptions } from 'electron'
import { errorText } from '../shared/error-text'
import { boxAnswerOf, serverBoxMessage, SERVER_BOX_BUTTONS, type BoxAnswer } from './second-launch'

/** The notice's second line: what Stop means for a server a LaunchAgent keeps. */
export const REOPEN_DETAIL = 'Stop ends this run; the LaunchAgent starts it again at your next login'

/** The reopen box: the shared text, Cancel as the default (and what Esc answers), Stop is 0. */
export function reopenBoxOptions(address: string): MessageBoxOptions {
  return {
    type: 'info',
    title: 'cc-cockpit',
    message: serverBoxMessage(address),
    detail: REOPEN_DETAIL,
    buttons: [...SERVER_BOX_BUTTONS],
    defaultId: 1,
    cancelId: 1,
    noLink: true
  }
}

export interface ReopenNoticeDeps {
  /** Server mode on macOS: anything else never shows a notice. */
  enabled: boolean
  /** The server's address text for the box (the gateway's origin, or the configured bind and port). */
  address: () => Promise<string>
  /** The test run's answer (`testBoxAnswer`); when set, no box is shown. */
  testAnswer: BoxAnswer | undefined
  /** `app.focus({ steal: true })`: before the box, so it is seen. */
  focus: () => void
  /** The native box through the dialog adapter (`electronDialogs()`); its response index. */
  showBox: (options: MessageBoxOptions) => Promise<number>
  /** `app.setActivationPolicy('accessory')`: takes the Dock icon away again. */
  accessory: () => void
  /** Stop: quit as SIGTERM does. */
  quit: () => void
  log: (line: string) => void
}

export interface ReopenNotice {
  /** `app`'s `activate`. */
  onActivate: () => void
  /** How many notices were shown (a test hook). */
  count: () => number
}

export function createReopenNotice(deps: ReopenNoticeDeps): ReopenNotice {
  let up = false
  let shown = 0
  const accessory = (): void => {
    try {
      deps.accessory()
    } catch (err) {
      deps.log(`reopen notice: could not set the accessory policy: ${errorText(err)}`)
    }
  }
  const run = async (): Promise<void> => {
    up = true
    shown++
    try {
      deps.focus()
      const answer =
        deps.testAnswer ??
        (await deps.showBox(reopenBoxOptions(await deps.address())).then(boxAnswerOf, () => 'cancel' as const))
      // The Dock icon goes first, whatever the answer: a Stop ends the process a moment later.
      accessory()
      if (answer === 'stop') deps.quit()
    } finally {
      up = false
    }
  }
  return {
    onActivate: () => {
      if (!deps.enabled) return
      if (up) {
        // The reopen that came while the box is up made the process Foreground again.
        accessory()
        return
      }
      run().catch((err: unknown) => deps.log(`reopen notice failed: ${errorText(err)}`))
    },
    count: () => shown
  }
}
