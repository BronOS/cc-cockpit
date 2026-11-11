// The only caller of Electron's `shell.openExternal` (test/unit/no-direct-open-external.test.ts
// guards it). Every link main opens goes through open-external.ts, which decides whether the host's
// browser is the right place at all (never in server mode, never for a browser view); this file is
// only its way out to the OS.
import { shell } from 'electron'

/**
 * The OS browser on an already checked http(s) URL. `shell` is read at each call, never captured:
 * the e2e specs replace `shell.openExternal` with a recorder after launch, and that recorder must
 * be what runs (no real browser in a test run).
 */
export function systemOpenExternal(url: string): Promise<void> {
  return shell.openExternal(url)
}
