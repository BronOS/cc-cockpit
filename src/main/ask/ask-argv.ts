// The argv of an Ask chat's `claude` (shared/design.md §5; decisions D2, D11, D12, D14). One builder for both modes, so
// the flags a mode runs with are decided here and nowhere else, from main's own reading of the caller (`isOwner(view)`),
// never from a page.
//
// - Owner (D2, D11): a regular session. `-p` with stream-json in and out, `--verbose` (stream-json output needs it),
//   `--include-partial-messages` (the answer as it is written), `--permission-prompts none` (D11: nothing can answer a
//   prompt there, so what would ask is refused and Claude is told why). No `--restricted`, `--safe-mode`,
//   `--strict-mcp-config` or `--tools`: the person's settings, CLAUDE.md, plugins, hooks, MCP servers and permission
//   rules all apply. No `--plugin-dir <data>/claude-plugins` and no cockpit hooks file: there is no tab (spec-review S5).
// - Guest (D12): the same plus `--restricted --safe-mode --strict-mcp-config --tools ""`: no tools at all, none of the
//   person's customizations (hooks included: `--restricted` alone still ran them, CLAUDE.md "Editor host rules"), no MCP
//   servers. The process runs as the owner, so this is what keeps the owner's files, accounts and plugins from a guest.
//   Proved against the real CLI by scripts/ask-guest-check.mjs (task 01), whose written-out lists must stay equal to
//   these (test/unit/ask-argv.test.ts compares them).
// - `--model`, `--effort`: from the closed lists of shared/session-options.ts (the value becomes an argument: an open
//   string could pass a flag). Absent: Claude Code's default. `--resume <id>` (D14): only a UUID, the form the stream's
//   init line gives (a session id is an argument too).
//
// The installed `claude --help` must list every flag a run uses (REQUIRED_FLAGS per mode, plus --effort / --resume when
// used), checked before the spawn: an older Claude Code that silently ignored `--safe-mode` would run a guest's chat
// with the owner's hooks (the editor's quick chat does the same check, plugins/editor/dist/lib/quick-chat.js).
import { SESSION_EFFORTS, SESSION_MODELS } from '../../shared/session-options'

export type AskMode = 'owner' | 'guest'

/** The owner's fixed flags (D2, D11), in order. scripts/ask-guest-check.mjs writes the same list out. */
export const ASK_OWNER_FLAGS: readonly string[] = Object.freeze([
  '-p',
  '--permission-prompts',
  'none',
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--verbose',
  '--include-partial-messages'
])

/** What a guest's argv adds (D12), in order. scripts/ask-guest-check.mjs writes the same list out. */
export const ASK_GUEST_FLAGS: readonly string[] = Object.freeze(['--restricted', '--safe-mode', '--strict-mcp-config', '--tools', ''])

/** The flags each mode always uses; `claude --help` must list every one. The owner's never demands the guest's (D2). */
export const REQUIRED_FLAGS: Readonly<Record<AskMode, readonly string[]>> = Object.freeze({
  owner: Object.freeze(['-p', '--permission-prompts', '--input-format', '--output-format', '--verbose', '--include-partial-messages', '--model']),
  guest: Object.freeze([
    '-p',
    '--permission-prompts',
    '--input-format',
    '--output-format',
    '--verbose',
    '--include-partial-messages',
    '--model',
    '--restricted',
    '--safe-mode',
    '--strict-mcp-config',
    '--tools'
  ])
})

/** A Claude session id as the stream's init line gives it. Only this form is stored or resumed (D14). */
export const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function isSessionUuid(value: unknown): value is string {
  return typeof value === 'string' && SESSION_UUID.test(value)
}

export interface AskArgvOptions {
  /** The executable (`claude`, found on the run's PATH). */
  bin: string
  mode: AskMode
  model?: string
  effort?: string
  /** D14: the key's stored session. */
  resume?: string
}

/** The whole argv, bin first. Throws for a model or effort off the lists, a resume id that is not a UUID or a bad mode. */
export function askArgv({ bin, mode, model, effort, resume }: AskArgvOptions): string[] {
  if (mode !== 'owner' && mode !== 'guest') throw new Error('Ask: unknown mode')
  if (typeof bin !== 'string' || bin === '' || bin.startsWith('-')) throw new Error('Ask: bad executable')
  if (model !== undefined && !(SESSION_MODELS as readonly string[]).includes(model)) throw new Error(`Ask: model must be one of ${SESSION_MODELS.join(', ')}`)
  if (effort !== undefined && !(SESSION_EFFORTS as readonly string[]).includes(effort)) throw new Error(`Ask: effort must be one of ${SESSION_EFFORTS.join(', ')}`)
  if (resume !== undefined && !isSessionUuid(resume)) throw new Error('Ask: only a session id can be resumed')
  return [
    bin,
    ...ASK_OWNER_FLAGS,
    ...(mode === 'guest' ? ASK_GUEST_FLAGS : []),
    ...(model !== undefined ? ['--model', model] : []),
    ...(effort !== undefined ? ['--effort', effort] : []),
    ...(resume !== undefined ? ['--resume', resume] : [])
  ]
}

/** The flags a run with these options needs from `claude --help`: the mode's, plus --effort and --resume when used. */
export function flagsFor(options: Pick<AskArgvOptions, 'mode' | 'effort' | 'resume'>): string[] {
  return [...REQUIRED_FLAGS[options.mode], ...(options.effort !== undefined ? ['--effort'] : []), ...(options.resume !== undefined ? ['--resume'] : [])]
}

/** Whether `flag` appears in `help` as a word of its own (`  -p, --print`, `--tools <tools...>`), not inside a longer flag. */
export function hasFlag(help: string, flag: string): boolean {
  let i = help.indexOf(flag)
  while (i !== -1) {
    const before = i === 0 ? ' ' : help[i - 1]
    const after = i + flag.length >= help.length ? ' ' : help[i + flag.length]
    const okBefore = before === ' ' || before === '\t' || before === '\n' || before === ','
    const okAfter = after === ' ' || after === '\t' || after === '\n' || after === '\r' || after === ',' || after === '='
    if (okBefore && okAfter) return true
    i = help.indexOf(flag, i + 1)
  }
  return false
}

/** The `flags` that `help` (the output of `claude --help`) does not list. */
export function missingFlags(help: string, flags: readonly string[]): string[] {
  return flags.filter((f) => !hasFlag(help, f))
}
