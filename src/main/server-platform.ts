// What server mode needs from the platform beyond the shared rules (docs/plans/20261119-server-mode-mac.md,
// decisions 1, 4 and 5; design-web.md §9.15). Pure: the effects are injected, index.ts passes Electron's.
//
// The table, by row:
// - darwin server: no Ozone exists there, so the run sits in the person's Aqua session and main sets
//   before `ready` what Linux gets from the re-exec's argv: the accessory policy (no Dock icon, no
//   menu bar), GPU off (nothing is composited on screen; the spike ran so), and Chromium's
//   `use-mock-keychain` (darwin's counterpart of `--password-store=basic`: the webview partitions'
//   cookie key, "cc-cockpit Safe Storage", stays off the keychain, which would prompt with nobody at the
//   screen and whose ACL the ad-hoc signature resets on every update). After `ready` it takes one
//   power hold for the whole run: a sleeping Mac serves nothing (idle sleep only; the display may sleep).
// - darwin desktop: nothing. A mock keychain there would break the desktop's safeStorage secrets.
// - Linux server: nothing here. The re-exec already put `--disable-gpu` and `--password-store=basic`
//   on argv, a never-shown window is all Ozone headless has anyway, and no whole-run hold is planned;
//   keep awake while Claude works applies there too (logind over the system bus, logind-inhibit.ts).
// The window side (never shown, `backgroundThrottling: false`) is the same on both server platforms
// and lives in the window factory, given `server` at construction (windows/create-window.ts).

/** What a run applies, by platform and mode. */
export interface ServerPlatform {
  /** `app.setActivationPolicy('accessory')` before `ready`: no Dock icon, no menu bar. */
  accessory: boolean
  /** `app.disableHardwareAcceleration()` before `ready`. */
  gpuOff: boolean
  /** Chromium's `use-mock-keychain` switch before `ready`. */
  mockKeychain: boolean
  /** One `powerHolds.hold(SERVER_HOLD_OWNER)` after `ready`, kept for the run. */
  holdAwake: boolean
}

/** The power hold's owner name (power-holds.ts): logs, tests and `pmset` reading. */
export const SERVER_HOLD_OWNER = 'server-mode'

/** Chromium's switch that keeps OSCrypt off the macOS keychain (decision 5). */
export const MOCK_KEYCHAIN_SWITCH = 'use-mock-keychain'

const NOTHING: ServerPlatform = { accessory: false, gpuOff: false, mockKeychain: false, holdAwake: false }

/** The row for this run. Only a darwin server applies anything (win32 never gets `server`: decideServerMode refuses). */
export function serverPlatform(platform: NodeJS.Platform, server: boolean): ServerPlatform {
  if (server && platform === 'darwin') return { accessory: true, gpuOff: true, mockKeychain: true, holdAwake: true }
  return { ...NOTHING }
}

/** Electron's side of the before-`ready` row (index.ts). */
export interface BeforeReadyEffects {
  setActivationPolicy(policy: 'accessory'): void
  disableHardwareAcceleration(): void
  appendSwitch(name: string): void
}

/**
 * The before-`ready` part of the row. Must run before `ready`: Chromium reads the switch and the GPU
 * choice at startup, and the policy set then means the Dock icon never appears (set later, it flashes).
 */
export function applyBeforeReady(row: ServerPlatform, effects: BeforeReadyEffects): void {
  if (row.accessory) effects.setActivationPolicy('accessory')
  if (row.gpuOff) effects.disableHardwareAcceleration()
  if (row.mockKeychain) effects.appendSwitch(MOCK_KEYCHAIN_SWITCH)
}

/** The part of PowerHolds this needs (power/power-holds.ts). */
export interface HoldSource<H> {
  hold(owner: string): H
}

/**
 * The after-`ready` part: the run's one power hold, or undefined when the row takes none. After `ready`
 * because the blocker is Electron's (the spike started it there) and `PowerHolds.hold` only logs a
 * backend that throws, so a call too early would fail quietly. The caller keeps the handle for the run
 * (the process exit ends the hold); it is never released while the server serves.
 */
export function holdForRun<H>(row: ServerPlatform, holds: HoldSource<H>): H | undefined {
  return row.holdAwake ? holds.hold(SERVER_HOLD_OWNER) : undefined
}
