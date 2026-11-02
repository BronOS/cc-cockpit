// Picks Chromium's `--password-store` for Linux desktops it does not recognise (FRICTION.md,
// settings-secrets). Electron's `safeStorage` chooses its Linux backend from XDG_CURRENT_DESKTOP:
// on a desktop it does not know (Hyprland, sway, i3, river, niri ...) it falls back to
// `basic_text`, which secret-store.ts refuses, even when gnome-keyring or KeePassXC is running and
// owns `org.freedesktop.secrets` on the session bus. Telling Chromium to use libsecret fixes that
// when a Secret Service really is there.
//
// Pure decision logic with an injected bus check, so it runs under vitest; only `main/index.ts`
// calls `app.commandLine.appendSwitch` (before `selectSecretStore` and `ready`). No `electron`
// import here.

import { execFileSync } from 'node:child_process'

/**
 * Desktops Electron already maps to a keyring backend, lowercased. Source: the
 * `safeStorage.getSelectedStorageBackend()` docs (node_modules/electron/electron.d.ts), which list
 * GNOME, X-Cinnamon, Deepin, Pantheon, XFCE, UKUI and Unity for libsecret and KDE for KWallet;
 * Chromium's `base::nix::GetDesktopEnvironment` also knows LXQt and the KDE aliases, so those are
 * kept as recognised too: no switch is forced there when the bus cannot be asked. XDG_CURRENT_DESKTOP is a
 * colon-separated list (`ubuntu:GNOME`); any entry counts.
 */
export const RECOGNISED_DESKTOPS: readonly string[] = [
  'gnome',
  'x-cinnamon',
  'cinnamon',
  'deepin',
  'pantheon',
  'xfce',
  'ukui',
  'unity',
  'lxqt',
  'kde'
]

/** Runs `argv[0] argv.slice(1)` (no shell) and returns its stdout; throws on a missing binary, a non-zero exit or a timeout. */
export type CommandRunner = (argv: string[]) => string

export interface PasswordStoreInput {
  platform: string
  argv: readonly string[]
  env: Record<string, string | undefined>
  /** app.isPackaged: a fake-secrets env var is honored only unpackaged (secret-store.ts). */
  isPackaged: boolean
  run: CommandRunner
}

/** The `--password-store` value to append, or null to leave Chromium's own choice alone. */
export type PasswordStoreChoice = 'gnome-libsecret' | null

const SECRETS_NAME = 'org.freedesktop.secrets'

/** The dbus-send argv that asks the bus daemon whether the Secret Service name has an owner. */
export const NAME_HAS_OWNER_ARGV: readonly string[] = [
  'dbus-send',
  '--session',
  '--print-reply',
  '--dest=org.freedesktop.DBus',
  '/org/freedesktop/DBus',
  'org.freedesktop.DBus.NameHasOwner',
  `string:${SECRETS_NAME}`
]

/** The real runner: argv only, about 1 s, stdout as text. A start-up must never wait longer on a bus. */
export const execRunner: CommandRunner = (argv) =>
  execFileSync(argv[0]!, argv.slice(1), {
    timeout: 1000,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  })

function recognisedDesktop(env: Record<string, string | undefined>): boolean {
  const entries = (env.XDG_CURRENT_DESKTOP ?? '')
    .split(':')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
  return entries.some((e) => RECOGNISED_DESKTOPS.includes(e) || e.startsWith('kde'))
}

/**
 * Decides whether to append `--password-store=gnome-libsecret`.
 *  - Not Linux, an explicit `--password-store` in argv, or a test run with the fake store: null.
 *  - Secret Service has an owner: the switch.
 *  - No owner: null (safeStorage reports unavailable and the error says how to fix it).
 *  - The check cannot run (no `dbus-send` on a minimal install, a timeout, an error): a silent miss
 *    would leave the bug in place, so append anyway when a session bus address is set and the
 *    desktop is not one Electron recognises; `safeStorage` then reports unavailable if there really
 *    is no keyring.
 */
export function choosePasswordStore(input: PasswordStoreInput): PasswordStoreChoice {
  const { platform, argv, env, isPackaged, run } = input
  if (platform !== 'linux') return null
  if (argv.some((a) => a === '--password-store' || a.startsWith('--password-store='))) return null
  if (env.CC_COCKPIT_FAKE_SECRETS === '1' && env.CC_COCKPIT_TEST === '1' && !isPackaged) return null

  let out: string
  try {
    out = run([...NAME_HAS_OWNER_ARGV])
  } catch {
    out = ''
  }
  const m = /boolean\s+(true|false)/.exec(out)
  if (m) return m[1] === 'true' ? 'gnome-libsecret' : null
  // Check impossible (or unreadable output).
  const hasBus = (env.DBUS_SESSION_BUS_ADDRESS ?? '') !== ''
  return hasBus && !recognisedDesktop(env) ? 'gnome-libsecret' : null
}
