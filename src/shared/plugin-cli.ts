// Plugin CLI commands (`ccc <name> …`, plan: Claude-operable foundation, Task 5): the limits and
// shapes shared by the CLI, main and the plugin host. Pure: no Node or Electron import, so all
// three bundles take it.
//
// The path of one call:
//   ccc  --plugin.cli.spec-->  main  (summary, usage, stdin: answered from the manifest)
//   ccc  --plugin.cli------->  main  --cli.run (RPC)-->  host  --> the plugin's handler
// and the result `{ stdout, stderr, code }` back the same way. Main is the authority on which
// plugin owns a name and whether it runs; the host only runs what main hands it.

/**
 * Most bytes each of stdin, stdout and stderr may take, measured AFTER JSON encoding: the socket
 * refuses any line over MAX_LINE_BYTES (1 MiB, protocol.ts) and the host RPC any message over
 * ~1 MiB, so a reply of a 256 KiB stdout, a 256 KiB stderr and the envelope stays well below
 * both. Measured encoded, not raw, because a text of control characters (`\u0001` becomes six
 * bytes) or quotes grows when it is put on the line: a raw cap would let 200 KiB of them through
 * as 1.2 MiB and the whole reply would be dropped.
 */
export const MAX_CLI_IO_BYTES = 256 * 1024

/** How long main waits for a plugin's handler before answering exit 124 (like `timeout(1)`). */
export const CLI_CALL_TIMEOUT_MS = 30_000

/**
 * How long `ccc` waits for main's reply to a plugin command: main's own 30 s plus a margin for the
 * round trip, so main's timeout answer (exit 124 and a message) arrives before the CLI gives up.
 */
export const CLI_REPLY_TIMEOUT_MS = CLI_CALL_TIMEOUT_MS + 5_000

/**
 * The CLI's hard deadline for a plugin command's call, connect to printed reply: a backstop that
 * holds even if the reply timer above never fires (a socket that neither answers, closes nor
 * errors in a way the round trip sees). Past it `ccc` exits CLI_TIMEOUT_CODE with a message. A
 * plugin command that hung with no output for over 120 s, sent right after its plugin reloaded,
 * is what this is for (friction round 1, Task 2).
 */
export const CLI_CLIENT_DEADLINE_MS = CLI_REPLY_TIMEOUT_MS + 5_000

/** Exit code main answers with when the handler did not finish in CLI_CALL_TIMEOUT_MS. */
export const CLI_TIMEOUT_CODE = 124

/** Calls of one plugin (in one project's host) running at once; one more is refused. */
export const MAX_CLI_IN_FLIGHT = 4

/** Appended to stdout or stderr that was cut at MAX_CLI_IO_BYTES. */
export const CLI_TRUNCATED_MARKER = '\n[ccc: output truncated]\n'

/** What a plugin command answers: its output and its exit code (0-255). */
export interface PluginCliResult {
  stdout: string
  stderr: string
  code: number
}

/** What `ccc` learns of a command before running it (the manifest's `contributes.cli` entry). */
export interface PluginCliSpec {
  name: string
  pluginId: string
  summary: string
  usage?: string
  stdin: boolean
  /** Present (true) only for a `stdinDash` command: stdin is read only when an argument is `-`. */
  stdinDash?: true
}

/** UTF-8 bytes `text` takes as a JSON string literal (quotes included). */
export function encodedBytes(text: string): number {
  // TextEncoder is a global in Node and Electron, so this file stays import-free.
  return new TextEncoder().encode(JSON.stringify(text)).length
}

/**
 * `text` when it fits `max` encoded bytes (see MAX_CLI_IO_BYTES), else its longest prefix that
 * fits together with `marker`. The prefix never ends inside a surrogate pair (half a character
 * would encode as a lone `\udxxx` escape and print as garbage). Binary search: encoded size grows
 * with the prefix length, and one stringify per step keeps a 256 KiB cap at ~20 passes.
 */
export function capEncoded(text: string, max: number = MAX_CLI_IO_BYTES, marker: string = CLI_TRUNCATED_MARKER): string {
  if (encodedBytes(text) <= max) return text
  // The marker's own escapes (`\n`) count; the quotes are counted once, with the prefix.
  const room = max - (encodedBytes(marker) - 2)
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (encodedBytes(text.slice(0, mid)) <= room) lo = mid
    else hi = mid - 1
  }
  let end = lo
  const last = text.charCodeAt(end - 1)
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end--
  return `${text.slice(0, end)}${marker}`
}

/**
 * An exit code a process can actually have: an integer 0-255. A plugin returning 300 would wrap
 * to 44 in `process.exit`, and a fraction or NaN means nothing; both become 1 (a failure the
 * plugin did not express properly). No code at all is success.
 */
export function exitCodeOf(code: unknown): number {
  if (code === undefined || code === null) return 0
  return typeof code === 'number' && Number.isInteger(code) && code >= 0 && code <= 255 ? code : 1
}

/**
 * A result from untrusted hands (a plugin's handler, or the host's reply in main) made into a
 * PluginCliResult: strings or nothing, each capped, the code made a real exit code.
 */
export function normalizeCliResult(value: unknown): PluginCliResult {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  return {
    stdout: capEncoded(typeof v.stdout === 'string' ? v.stdout : ''),
    stderr: capEncoded(typeof v.stderr === 'string' ? v.stderr : ''),
    code: exitCodeOf(v.code)
  }
}
