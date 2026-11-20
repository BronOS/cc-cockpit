// The one place main reads a page's renderer pid and kills it (the hung-page watchdog,
// hung-navigation.ts; grep test no-direct-renderer-kill.test.ts). SIGKILL, never
// `forcefullyCrashRenderer`: that one is a crash, and on a Linux host whose core_pattern pipes to
// systemd-coredump (Debian) the renderer sits in `do_exit` for 40 s and more writing its core before
// `render-process-gone` fires, while a navigation sent meanwhile never commits. A SIGKILL writes no
// core (and ends one being written: gone 4 ms later, Debian VM, Electron 45.1.0).
import type { WebContents } from 'electron'

/** The page's renderer process id now; 0 when it has none (gone, or between two). */
export function rendererOsPid(wc: WebContents): number {
  if (wc.isDestroyed()) return 0
  try {
    return wc.getOSProcessId()
  } catch {
    return 0
  }
}

/**
 * SIGKILL `pid` if it is still `wc`'s renderer, read again in this same synchronous step (a renderer
 * replaced meanwhile, or none, is never signalled; pid 0 or less would signal a process group, and
 * main's own pid is never one). True when the signal went.
 */
export function killRenderer(wc: WebContents, pid: number): boolean {
  if (!(pid > 0) || pid === process.pid) return false
  if (rendererOsPid(wc) !== pid) return false
  try {
    process.kill(pid, 'SIGKILL')
    return true
  } catch {
    // Gone between the read and the signal (ESRCH): nothing was killed.
    return false
  }
}
