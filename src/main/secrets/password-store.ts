// Picks Chromium's `--password-store` for Linux desktops it does not recognise (FRICTION.md,
// settings-secrets). Electron's `safeStorage` chooses its Linux backend from XDG_CURRENT_DESKTOP:
// on a desktop it does not know (Hyprland, sway, i3, river, niri ...) it falls back to
// `basic_text`, which secret-store.ts refuses, even when gnome-keyring or KeePassXC is running and
// owns `org.freedesktop.secrets` on the session bus. Telling Chromium to use libsecret fixes that
// when a Secret Service really is there.
//
// The switch is appended only when the bus confirms an owner, never on a guess: with the switch and
// no keyring, Electron 45 does NOT report the problem. Checked by hand on a private bus without a
// Secret Service: `isAsyncEncryptionAvailable()` true, `getSelectedStorageBackend()`
// `gnome_libsecret`, and ciphertext tagged `v10`, Chromium's hard-coded key. secret-store.ts refuses
// that tag as well (the keyring can still fail after this check), so this file only decides when the
// switch is worth trying.
//
// Recognised desktops keep Electron's own choice even when a Secret Service runs: on KDE the backend
// is KWallet, and switching an existing user to libsecret would make every secret stored through
// KWallet unreadable (a separately running Secret Service is common there).
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
 * kept as recognised too: no switch is ever appended there. XDG_CURRENT_DESKTOP is a colon-separated
 * list (`ubuntu:GNOME`); any entry counts.
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
 *  - A desktop Electron recognises: null, whatever the bus says (its own backend, KWallet on KDE,
 *    is where an existing user's secrets are).
 *  - Otherwise the bus decides: the switch only when `org.freedesktop.secrets` has an owner. No
 *    owner, or no answer at all (no `dbus-send`, a timeout, an error, unreadable output): null, so
 *    Electron stays on `basic_text` and secret-store.ts refuses with the fix in its message.
 */
export function choosePasswordStore(input: PasswordStoreInput): PasswordStoreChoice {
  const { platform, argv, env, isPackaged, run } = input
  if (platform !== 'linux') return null
  if (argv.some((a) => a === '--password-store' || a.startsWith('--password-store='))) return null
  if (env.CC_COCKPIT_FAKE_SECRETS === '1' && env.CC_COCKPIT_TEST === '1' && !isPackaged) return null
  if (recognisedDesktop(env)) return null

  let out: string
  try {
    out = run([...NAME_HAS_OWNER_ARGV])
  } catch {
    return null
  }
  return /boolean\s+true\b/.test(out) ? 'gnome-libsecret' : null
}
