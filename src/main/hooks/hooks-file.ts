// `<data>/hooks.json`: the settings file the app hands to every `claude` it starts
// (`claude --settings <this file>`, see tabs/claude-argv.ts). The user's own settings are never
// touched; Claude merges this file's hooks with theirs. Regenerated at every start because the
// wrapper path it names can change (a moved data dir, a dev vs packaged build), and when the
// setting that adds the `statusLine` changes (a `claude` reads the file at its start, so tabs
// already running keep what they started with).
import { HOOK_EVENTS, HOOK_MATCHERS, type HookEvent } from '../../shared/hooks'
import { shellQuote } from './shell-quote'
import { writeFileAtomic } from './write-file-atomic'

/** Claude kills a hook command after this many seconds. `ccc hook` itself gives up after 500 ms. */
export const HOOK_TIMEOUT_SECONDS = 5

/*
 * Every hook is synchronous: no `"async": true`, on purpose (Task 13 review).
 *
 * claude 2.1.312 does have a command-hook `async` field (in the settings schema embedded in the
 * binary, next to `asyncRewake`; the official `claude-security` plugin uses it). An async hook is
 * backgrounded and Claude goes on at once. Each `ccc` spends ~85-100 ms starting Electron as Node
 * before it connects, so two backgrounded `ccc` processes reach main's socket in the order their
 * startup jitter decides, not in event order. The bad case: an async `PreToolUse` for a tool that
 * needs approval, then at once the synchronous `Notification(permission_prompt)`. The
 * Notification can arrive first, and the tab shows "working" during a permission prompt, the
 * state the cockpit exists to surface. Same for a turn's last tool event against `Stop`: a stale
 * "working" after "waiting" holds the send queue (Task 15) until the user types. Nothing in the
 * payload orders events (no timestamp or sequence number), and a CLI-side clock would carry the
 * same startup jitter, so there is no ordering field to sort on either.
 *
 * Synchronous, Claude waits for `ccc` to exit, and `ccc` exits only after its request is handed
 * to the kernel (client.ts, `socket.end(line, cb)`), so delivery order follows event order. The
 * cost is ~85-100 ms per tool call (measured in Task 13, well inside the budget). Do not turn
 * `async` back on without first giving the Task 14 reducer a reliable ordering to sort on.
 * The 500 ms cap in `ccc hook` bounds the wait either way.
 */
interface HookCommand {
  type: 'command'
  command: string
  timeout: number
}

interface HookGroup {
  matcher?: string
  hooks: HookCommand[]
}

/**
 * Claude Code's `statusLine` setting. Only `type` and `command`: Claude deep-merges the settings
 * layers (claude 2.1.319 merges each source over the last with lodash `mergeWith`, a customizer
 * that only concatenates arrays), so the person's own `padding`, `refreshInterval` and
 * `hideVimModeIndicator` from their user, project or local settings still apply to this command.
 * Setting any of them here would override theirs. Our `command` wins over theirs because
 * `--settings` (flagSettings) sits above those three layers; `ccc statusline` then runs theirs
 * (cli/statusline.ts). A managed (policy) statusLine sits above ours, and then nothing of this runs.
 */
interface StatusLineCommand {
  type: 'command'
  command: string
}

export interface HooksSettings {
  hooks: Record<string, HookGroup[]>
  statusLine?: StatusLineCommand
}

export interface HooksFileOptions {
  /**
   * The app setting "Rate limits from the status line" (`app.json` › `statusLineUsage`, default
   * on): add the `statusLine` that runs `ccc statusline`. Off, the file has hooks only.
   */
  statusLine?: boolean
}

/** The command Claude runs for `event`: `'<wrapper>' hook <Event>`, the path single-quoted. */
export function hookCommand(cccPath: string, event: HookEvent): string {
  return `${shellQuote(cccPath)} hook ${event}`
}

/** The status line command: `'<wrapper>' statusline`, the path single-quoted like a hook's. */
export function statusLineCommand(cccPath: string): string {
  return `${shellQuote(cccPath)} statusline`
}

export function buildHooksSettings(cccPath: string, options: HooksFileOptions = {}): HooksSettings {
  const hooks: Record<string, HookGroup[]> = {}
  for (const event of HOOK_EVENTS) {
    const command: HookCommand = {
      type: 'command',
      command: hookCommand(cccPath, event),
      timeout: HOOK_TIMEOUT_SECONDS
    }
    const group: HookGroup = { hooks: [command] }
    const matcher = HOOK_MATCHERS[event]
    if (matcher !== undefined) group.matcher = matcher
    hooks[event] = [group]
  }
  if (options.statusLine !== true) return { hooks }
  return { hooks, statusLine: { type: 'command', command: statusLineCommand(cccPath) } }
}

/**
 * Write hooks.json. No `schemaVersion`: this is Claude's settings format, not one of our state
 * files, and the file is rebuilt from scratch at every start so there is nothing to migrate.
 */
export function writeHooksFile(hooksPath: string, cccPath: string, options: HooksFileOptions = {}): void {
  writeFileAtomic(hooksPath, JSON.stringify(buildHooksSettings(cccPath, options), null, 2) + '\n', 0o600)
}
