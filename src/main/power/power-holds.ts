// Keeping the computer out of idle sleep (design.md §3 "Keep awake"): the one place main holds the OS's
// "do not idle-sleep" request, as separate holds with their own owner. Plain TypeScript over a backend
// so vitest runs it; Electron's `powerSaveBlocker` is only in electron-power.ts (CLAUDE.md, adapters).
//
// Why one Electron blocker per hold instead of one shared blocker and a count: Electron keeps every
// blocker id apart and the OS request stands while any id is live, so a hold can never release
// another owner's. Two owners are planned: KeepAwake (while a Claude tab works, keep-awake.ts) and
// macOS server mode, which holds one for its whole run (docs/plans/20261119-server-mode-mac.md,
// decision 4). The server's code calls `powerHolds.hold('server-mode')` once at start and keeps the
// handle for the run (the process exit ends it; release() only if the run ever stops serving); the
// session owner starting and stopping all day never touches it.
//
// What the request is, per platform (Electron's `prevent-app-suspension`): an IOPM no-idle-sleep
// assertion on macOS (`pmset -g assertions` lists it), SetThreadExecutionState on Windows. On Linux
// Electron only asks the desktop's session manager over the session bus (nothing on Hyprland or a
// server), so with `systemd-inhibit` on PATH each hold also takes a logind sleep block lock
// (logind-inhibit.ts, `systemd-inhibit --list` shows it; system bus, no session bus needed). It keeps
// the system from idle sleep and lets the display sleep; it does not stop a lid close, nor on macOS
// and Windows a Sleep the person picks (on Linux logind refuses that one while the lock stands).

/** The OS side (electron-power.ts, logind-inhibit.ts): one blocker per start. */
export interface PowerSaveBackend {
  /** Start one blocker for `owner` (a backend may show it as the reason); returns its id. */
  start(owner: string): number
  /** Stop that blocker; an id already stopped is ignored. */
  stop(id: number): void
}

/** One owner's request to keep the computer from idle sleep. */
export interface PowerHold {
  readonly owner: string
  /** Stop this hold's blocker. Idempotent: a second call does nothing (never another owner's). */
  release(): void
}

export class PowerHolds {
  /** Live holds and their blocker id (undefined: the backend's start threw, so there is nothing to stop). */
  private readonly live = new Map<PowerHold, number | undefined>()

  constructor(
    private readonly backend: PowerSaveBackend,
    private readonly log: (line: string) => void = () => {}
  ) {}

  /**
   * A new hold for `owner` (a name for logs and tests, not a key: two holds of one owner are two
   * blockers). A backend that throws (a platform with no power service) gives a hold that does
   * nothing, logged: keeping awake is a convenience and must never break what asked for it.
   */
  hold(owner: string): PowerHold {
    let id: number | undefined
    try {
      id = this.backend.start(owner)
    } catch (err) {
      this.log(`keep awake: could not start the power save blocker for ${owner}: ${err instanceof Error ? err.message : String(err)}`)
    }
    const hold: PowerHold = {
      owner,
      release: () => {
        if (!this.live.has(hold)) return
        const held = this.live.get(hold)
        this.live.delete(hold)
        if (held === undefined) return
        try {
          this.backend.stop(held)
        } catch (err) {
          this.log(`keep awake: could not stop the power save blocker of ${owner}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }
    this.live.set(hold, id)
    return hold
  }

  /** The owners of the live holds, one entry per hold (for tests and logs). */
  owners(): string[] {
    return [...this.live.keys()].map((h) => h.owner)
  }
}
