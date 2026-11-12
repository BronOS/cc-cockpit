// The two `ccc web` commands a built-in SSH link runs on the server (design-remote-desktop.md §5.6):
// `web status --json` (is it a cc-cockpit server, which gateway port, which sign-in mode, TLS, the
// version) and `web add-device` (a one-time sign-in token). Plain parsing over an injected `exec`,
// so the transport (ssh-link.ts over `ssh2`) is not this file's business and unit tests feed it text.
//
// Trust: everything the server prints is untrusted. Only the last non-empty stdout line is read
// (rc-file noise and a motd come before it), it is parsed with JSON.parse or URL and checked field
// by field (a field of the wrong type refuses, never defaults), and any server text that reaches a
// message is capped and stripped of control characters (`shownText`). The command itself is
// `remoteCommand` (shared/remote-servers.ts): the fixed `sh -c` script with every word single-quoted.
import { errorText } from '../../shared/error-text'
import { isPlainObject } from '../../shared/guards'
import { REMOTE_CCC_MISSING, isLocalPort, parseRemoteLink, remoteCommand } from '../../shared/remote-servers'
import type { WebAccessMode } from '../../shared/types'

/** What one remote command gave back: the exit code is null when it ended on a signal or sent none. */
export interface RemoteExecResult {
  stdout: string
  stderr: string
  code: number | null
}

/**
 * Runs one command string on the server (its login shell parses it: `remoteCommand` quotes every
 * word). The transport bounds it (output cap, deadline); a transport failure rejects.
 */
export type RemoteExec = (command: string) => Promise<RemoteExecResult>

/** A refused or failed remote command; the message is for the person, as is. */
export class RemoteCommandError extends Error {
  override name = 'RemoteCommandError'
}

/** Remote text in a message is cut here. */
const MAX_SHOWN = 300
/** A version string is cut here (it is shown in "it runs <version>"). */
const MAX_VERSION = 40

/** Remote text made safe to show: control characters become spaces, runs collapse, capped. */
export function shownText(text: string, max = MAX_SHOWN): string {
  let out = ''
  for (const ch of text) {
    const c = ch.codePointAt(0) as number
    const control = c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029
    out += control ? ' ' : ch
  }
  out = out.split(' ').filter((w) => w !== '').join(' ')
  return out.length > max ? `${out.slice(0, max - 1)}…` : out
}

/** The last non-empty line of `text` (a trailing `\r` dropped), or ''. */
export function lastLine(text: string): string {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] as string).trim()
    if (line !== '') return line
  }
  return ''
}

/**
 * The answer line of a finished `ccc <args>` run on `host`, or the person's reason why there is
 * none: the remote has no `ccc` (the script's marker line, exit 127), the command failed (its last
 * stderr line), or it printed nothing (the wrapper exits 0 silently when no app runs there).
 */
export function answerLine(host: string, result: RemoteExecResult): string {
  const line = lastLine(result.stdout)
  // Before the exit code: the script exits 127 with the marker as its last line.
  if (line === REMOTE_CCC_MISSING) {
    throw new RemoteCommandError(`cc-cockpit's ccc was not found on ${host}. Set the path to ccc in the server's settings, or install cc-cockpit there.`)
  }
  if (result.code !== 0) {
    const said = lastLine(result.stderr)
    if (said !== '') throw new RemoteCommandError(`ccc on ${host} failed: ${shownText(said)}`)
    throw new RemoteCommandError(
      result.code === null ? `ccc on ${host} was stopped before it answered.` : `ccc on ${host} failed (exit code ${result.code}).`
    )
  }
  if (line === '') throw new RemoteCommandError(`cc-cockpit is not installed on ${host}, or the server is not running.`)
  return line
}

/** Run `ccc <args>` on `host` through `exec` and return the answer line (`answerLine`). */
export async function runCcc(exec: RemoteExec, host: string, args: readonly string[], override?: string): Promise<string> {
  let command: string
  try {
    command = remoteCommand(args, override)
  } catch (err) {
    throw new RemoteCommandError(errorText(err))
  }
  let result: RemoteExecResult
  try {
    result = await exec(command)
  } catch (err) {
    // The transport's own words (the deadline, the output cap, the connection gone): already plain.
    throw new RemoteCommandError(`running ccc on ${host} failed: ${shownText(errorText(err))}`)
  }
  return answerLine(host, result)
}

export interface RemoteStatus {
  /** The gateway's listening port on the server's loopback (the tunnel's `P`). */
  port: number
  mode: WebAccessMode
  version: string
}

const MODES: readonly WebAccessMode[] = ['link', 'password', 'confirm', 'none']

/**
 * The `ccc web status --json` answer line checked field by field (design §5.6 step 1), with the
 * version gate (§9) and the https refusal (§5.8). Nothing of the reply is trusted: a field of the
 * wrong type is a refusal, not a default.
 */
export function parseServerStatus(host: string, line: string): RemoteStatus {
  let reply: unknown
  try {
    reply = JSON.parse(line)
  } catch {
    throw new RemoteCommandError(`${host} answered something that is not a cc-cockpit status: ${shownText(line, 120)}`)
  }
  if (!isPlainObject(reply)) throw new RemoteCommandError(`${host} answered something that is not a cc-cockpit status.`)
  if (reply['server'] !== true) {
    throw new RemoteCommandError(`${host} is not a cc-cockpit server in server mode. Direct works with the link a desktop app shows.`)
  }
  const rawVersion = reply['version']
  const version = typeof rawVersion === 'string' && rawVersion !== '' ? shownText(rawVersion, MAX_VERSION) : undefined
  const scheme = reply['scheme']
  // `scheme` is what marks a server whose Host check takes the tunnel's port (§5.7, §9): without it,
  // every page load through the tunnel would be refused, so refuse here, before any window opens.
  if (scheme !== 'http' && scheme !== 'https') {
    throw new RemoteCommandError(`Update cc-cockpit on ${host} (it runs ${version ?? 'an older version'}).`)
  }
  if (scheme === 'https') {
    throw new RemoteCommandError(
      `${host} serves https, whose certificate cannot match the tunnel's 127.0.0.1. Connect Direct with its address, or turn TLS off: the SSH tunnel encrypts already.`
    )
  }
  const gateway = reply['gateway']
  if (reply['enabled'] !== true || !isPlainObject(gateway) || gateway['state'] === 'off') {
    throw new RemoteCommandError(`Web access is off on ${host} (\`ccc web enable\` there turns it on).`)
  }
  if (gateway['state'] !== 'listening') {
    const reason = typeof gateway['reason'] === 'string' ? `: ${shownText(gateway['reason'], 160)}` : ''
    throw new RemoteCommandError(`The web gateway on ${host} is not listening${reason}`)
  }
  const port = gateway['port']
  if (!isLocalPort(port)) throw new RemoteCommandError(`${host} reported no usable gateway port.`)
  const mode = reply['mode']
  if (typeof mode !== 'string' || !MODES.includes(mode as WebAccessMode)) {
    throw new RemoteCommandError(`${host} reported a sign-in mode this app does not know. Update cc-cockpit here or there.`)
  }
  return { port, mode: mode as WebAccessMode, version: version ?? '' }
}

/**
 * The `ccc web add-device` answer line: the one-time token of the link it prints, nothing else
 * (design §5.6 step 2). The link's origin is the server's idea of itself (maybe an external name);
 * the window uses the tunnel's own origin, so only the token is kept.
 */
export function parseAddDeviceToken(host: string, line: string): string {
  const link = parseRemoteLink(line)
  if ('error' in link || link.token === undefined) {
    throw new RemoteCommandError(`${host} did not answer with an add-device link.`)
  }
  return link.token
}

/** `ccc web status --json` on `host` (`ccc`: the record's path override). */
export async function serverStatus(exec: RemoteExec, host: string, override?: string): Promise<RemoteStatus> {
  return parseServerStatus(host, await runCcc(exec, host, ['web', 'status', '--json'], override))
}

/** `ccc web add-device` on `host`: the token only. */
export async function addDeviceToken(exec: RemoteExec, host: string, override?: string): Promise<string> {
  return parseAddDeviceToken(host, await runCcc(exec, host, ['web', 'add-device'], override))
}
