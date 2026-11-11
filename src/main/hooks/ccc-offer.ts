// The start-up question "Install the ccc command?" (main side). main decides, the renderer only
// asks `ccc.offer` and draws the dialog; the install itself is the Settings button's code path.
//
// Decisions:
//  - Offered only when nothing is at ~/.local/bin/ccc ('missing'). 'installed' needs nothing, and
//    'foreign' (a file, or a link to another tool or another data dir's wrapper) is something the
//    installer refuses to replace, so a "Yes" could only fail: the Settings row explains it there.
//  - Once per app launch, to the first project window that asks (the claim), not once per window:
//    a second project window, or a page reload, never asks again.
//  - Never in a test run (every e2e launch would grow a dialog over what the spec drives) unless
//    the spec sets CC_COCKPIT_CCC_OFFER=1, which is itself honoured only in a test run.
//  - Never in server mode (design-web.md §9.9): its modal opened on the hidden page, which nobody
//    sees, and left that page's root inert.
//  - A link that cannot be inspected (EACCES...) means we do not know it is missing: no offer.
import type { CccCommandState } from '../../shared/ipc'

export interface CccOfferInputs {
  /** Main's server flag (server-mode.ts). */
  server?: boolean
  /** isTestRun(): e2e launch. */
  testRun: boolean
  /** CC_COCKPIT_CCC_OFFER=1: a test asks for the offer. */
  forcedByTest: boolean
  /** The user did not switch the offer off ("Don't ask again"). */
  enabled: boolean
  state: CccCommandState
}

export function shouldOfferCcc(i: CccOfferInputs): boolean {
  if (i.server) return false
  if (i.testRun && !i.forcedByTest) return false
  return i.enabled && i.state === 'missing'
}

export class CccOffer {
  private claimed = false

  constructor(
    private readonly deps: {
      server?: boolean
      testRun: boolean
      forcedByTest: boolean
      enabled: () => boolean
      state: () => CccCommandState
    }
  ) {}

  /** True for the first caller of the launch when the question should be asked; false after that. */
  claim(): boolean {
    if (this.claimed) return false
    this.claimed = true
    let state: CccCommandState
    try {
      state = this.deps.state()
    } catch {
      return false
    }
    return shouldOfferCcc({
      server: this.deps.server,
      testRun: this.deps.testRun,
      forcedByTest: this.deps.forcedByTest,
      enabled: this.deps.enabled(),
      state
    })
  }
}
