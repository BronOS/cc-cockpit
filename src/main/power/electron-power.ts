// The only file that touches Electron's `powerSaveBlocker` (CLAUDE.md, "Electron-only modules sit
// behind adapter files"; no-direct-power-save-blocker.test.ts). The logic is in power-holds.ts and
// keep-awake.ts, which tests drive with a fake backend.
import { powerSaveBlocker } from 'electron'
import type { PowerSaveBackend } from './power-holds'

/**
 * `prevent-app-suspension` only, never `prevent-display-sleep`: the point is that work goes on, not
 * that the screen stays lit (a lit screen nobody looks at only drains the battery).
 */
export const electronPowerSaveBackend: PowerSaveBackend = {
  start: () => powerSaveBlocker.start('prevent-app-suspension'),
  stop: (id) => {
    if (powerSaveBlocker.isStarted(id)) powerSaveBlocker.stop(id)
  }
}
