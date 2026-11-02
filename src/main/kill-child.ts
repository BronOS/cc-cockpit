// Shared by main and the plugin host (src/host imports it, as it does store/json-file.ts). Not in
// src/shared: that folder is type-checked for the renderer too, which has no Node types.
import type { ChildProcess } from 'node:child_process'

/**
 * SIGKILL the child's whole process group (POSIX), or just the child when that is not possible.
 * The group only exists for a child spawned with `detached: true` (setsid); win32 has no process
 * groups, and a negative pid there would not mean one.
 */
export function killChild(child: ChildProcess): void {
  try {
    if (process.platform !== 'win32' && child.pid !== undefined) {
      process.kill(-child.pid, 'SIGKILL')
      return
    }
  } catch {
    /* no such group (already gone): fall through to the child itself */
  }
  try {
    child.kill('SIGKILL')
  } catch {
    /* already gone */
  }
}
