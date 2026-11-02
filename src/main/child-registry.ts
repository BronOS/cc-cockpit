// The short-lived helper processes main starts itself (the login-shell env capture, git for
// plugin installs, the diff probe), so app quit can kill them.
//
// Each of those has its own timeout, but that is a timer in main: quitting while one is pending
// destroys the timer with the process and the child runs on with nobody to kill it. A login shell
// that prompts or hangs, or a `git clone` of a large repo (2 min cap), would then
// outlive the app indefinitely. `will-quit` calls `liveChildren.killAll()`.
//
// Not for the plugin hosts (host-manager.ts disposeAll) or the PTYs (PtyService.disposeAll): they
// have their own quit paths. Not in kill-child.ts either: the plugin host imports that file and
// has its own children to kill (HostContexts.killChildrenAndFlush).
import type { ChildProcess } from 'node:child_process'
import { killChild } from './kill-child'

export class ChildRegistry {
  private readonly live = new Set<ChildProcess>()
  private disposed = false

  /**
   * Remember `child` until it exits. Returns it, for use inline after a spawn. A child whose spawn
   * failed (no pid: its 'error' follows) has nothing to kill and is not kept.
   */
  track<T extends ChildProcess>(child: T): T {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return child
    // Spawned after quit began (a check whose env resolved during will-quit): nothing will be
    // left to kill it, so it goes now.
    if (this.disposed) {
      killChild(child)
      return child
    }
    this.live.add(child)
    // 'exit', not 'close': close waits for every holder of the pipes, and a login shell's
    // background job (the user's own ssh-agent) may hold them for good. Forgetting the child at
    // exit also keeps killChild from signalling a process group id the OS may hand out again.
    child.once('exit', () => this.live.delete(child))
    return child
  }

  /** App quit: SIGKILL every tracked child (with its process group). Synchronous, no waiting. */
  killAll(): void {
    this.disposed = true
    for (const child of this.live) killChild(child)
    this.live.clear()
  }

  /** Children still tracked (tests). */
  get size(): number {
    return this.live.size
  }
}

/** The registry main's spawn sites use; killed in `will-quit` (index.ts). */
export const liveChildren = new ChildRegistry()
