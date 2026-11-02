// Builds the environment for a PTY child (a tab of any kind, or a terminal overlay) from the
// login-shell env.
import { delimiter } from 'node:path'
import type { Env } from './login-env'

/**
 * The socket identity of a PTY child. The token's kind (a Claude tab's session token, or the
 * window token of a shell or command tab or a terminal overlay) is not in the environment at all:
 * main decides it on lookup (socket-server.ts), so the same variables serve both and the CLI sends
 * the token the same way for each.
 */
export interface TabEnvVars {
  /** `APP_TAB_ID`; a terminal overlay is not a tab and has none. */
  tabId?: string
  token: string
  /**
   * The CLI socket path, only while main's server is listening on it. Left out otherwise: a path
   * main could not bind may be held by someone else (a foreign listener, or another user's
   * pre-created fallback dir on a shared /tmp), and the tab's hooks would send it the token and
   * every prompt.
   */
  sock?: string
}

export interface PtyEnvOptions {
  /** `<data>/bin`, prepended to PATH so `ccc` is found inside a tab. */
  binDir: string
  /** The child's token and socket; absent = none (the login-env capture, a test). */
  tab?: TabEnvVars
}

/**
 * Variables that must not leak into a child:
 * - `CLAUDECODE` and `CLAUDE_CODE_*`: a cockpit started from inside a Claude session would
 *   otherwise make `claude` refuse to start as a nested session.
 * - `ELECTRON_*`: `ELECTRON_RUN_AS_NODE` would turn any Electron app run in a tab into plain Node.
 */
export function isStrippedVar(name: string): boolean {
  return name === 'CLAUDECODE' || name.startsWith('CLAUDE_CODE_') || name.startsWith('ELECTRON_')
}

export function buildPtyEnv(loginEnv: Env, { binDir, tab }: PtyEnvOptions): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(loginEnv)) {
    if (v === undefined || isStrippedVar(k)) continue
    env[k] = v
  }
  // Avoid a trailing delimiter (an empty PATH entry means "cwd") when PATH was unset.
  env.PATH = env.PATH ? `${binDir}${delimiter}${env.PATH}` : binDir
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  // Drop any inherited tab vars first so a stale token from an outer cockpit never reaches a
  // child (and an overlay never shows an outer tab's id).
  delete env.APP_TAB_ID
  delete env.APP_TAB_TOKEN
  delete env.CC_COCKPIT_SOCK
  if (tab) {
    if (tab.tabId !== undefined) env.APP_TAB_ID = tab.tabId
    env.APP_TAB_TOKEN = tab.token
    if (tab.sock !== undefined) env.CC_COCKPIT_SOCK = tab.sock
  }
  return env
}
