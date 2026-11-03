// Claude Code's own markup in a user turn, taken out of a prompt before it becomes a tab's
// `lastPrompt` (status-reducer.ts), the way paste-wrappers.ts takes out paste wrappers.
//
// The incident: the Sessions panel described a tab as `<task-notification> <task-id>…`,
// `<system-reminder>…`, `<bash-input>ls</bash-input><bash-stdout>…` or
// `<command-name>/review</command-name><command-message>review</command-message>…`. Claude Code
// delivers these as user turns (a background task finishing, a `!` shell command and its output, a
// slash command, a message from another agent), and UserPromptSubmit hands them to us as the
// `prompt`. None of it is what the person asked.
//
// The tag names are the ones claude 2.1.316 builds (closing tags found in the binary: `</bash-input>`,
// `</local-command-stdout>`, `</task-notification>`, ..., no live session needed). Only these names
// are touched: HTML or XML the person typed (`<div>`, `<thinking>`) stays as is, and so does a
// known name with no closing tag (a person writing about `<system-reminder>` mid-sentence).
//
// What a prompt turns into:
//   - only harness blocks: undefined, "not a new prompt" (the caller keeps the previous one);
//   - a slash command (`<command-name>/x</command-name>` + `<command-args>a b</command-args>`):
//     `/x a b`;
//   - a `!` shell command (`<bash-input>ls</bash-input>`, its output blocks dropped): `! ls`;
//   - otherwise the person's text with every harness block cut out, trimmed.
//
// Linear time: the prompt is hook input of up to ~1 MiB. A block moves the scan past its closer,
// and a name whose closer is missing is remembered, so n unclosed openers cost one search each
// name, not n searches to the end.

/** Blocks that are harness input, never the person's words. */
const HARNESS_TAGS: ReadonlySet<string> = new Set([
  'system-reminder',
  'system-note',
  'task-notification',
  'agent-message',
  'teammate-message',
  'cross-session-message',
  'coordinator-task',
  'webhook-payload',
  'channel',
  'bash-input',
  'bash-stdout',
  'bash-stderr',
  'local-command-stdout',
  'local-command-stderr',
  'local-command-caveat',
  'command-name',
  'command-message',
  'command-args',
  'command-contents',
  'user-prompt-submit-hook',
  'new-diagnostics',
  'mcp-resource',
  'persisted-output',
  'interrupted-output'
])

/** An opening tag: `<name>` or `<name attr="…">`. `[^<>]` keeps one match from running past the next tag. */
const OPENER = /<([a-z][a-z0-9-]*)(?:\s[^<>]*)?>/g

/** At most this much of a command's name or args (they come from the same 2 KiB-capped prompt anyway). */
const MAX_PART = 500

/**
 * The person's prompt with Claude Code's harness blocks handled (header), or undefined when
 * nothing of the person is left. Text with no known opener comes back unchanged.
 */
export function cleanHarnessMarkup(text: string): string | undefined {
  if (!text.includes('<')) return text
  const kept: string[] = []
  let commandName: string | undefined
  let commandArgs: string | undefined
  let bashInput: string | undefined
  let found = false
  let keptUpTo = 0
  const unclosed = new Set<string>()
  OPENER.lastIndex = 0
  for (let m = OPENER.exec(text); m !== null; m = OPENER.exec(text)) {
    const name = m[1] as string
    if (!HARNESS_TAGS.has(name) || unclosed.has(name)) continue
    const bodyStart = m.index + m[0].length
    const closer = `</${name}>`
    const close = text.indexOf(closer, bodyStart)
    if (close === -1) {
      unclosed.add(name)
      continue
    }
    found = true
    const body = text.slice(bodyStart, close)
    if (name === 'command-name') commandName ??= body.trim().slice(0, MAX_PART)
    else if (name === 'command-args') commandArgs ??= body.trim().slice(0, MAX_PART)
    else if (name === 'bash-input') bashInput ??= body.trim()
    kept.push(text.slice(keptUpTo, m.index))
    keptUpTo = close + closer.length
    OPENER.lastIndex = keptUpTo
  }
  if (!found) return text
  kept.push(text.slice(keptUpTo))
  const rest = kept.join('').replace(/\n{3,}/g, '\n\n').trim()
  let head: string | undefined
  if (commandName !== undefined && commandName !== '') {
    const name = commandName.startsWith('/') ? commandName : `/${commandName}`
    head = commandArgs ? `${name} ${commandArgs}` : name
  } else if (bashInput !== undefined && bashInput !== '') {
    head = `! ${bashInput}`
  }
  if (head !== undefined) return rest === '' ? head : `${head}\n${rest}`
  return rest === '' ? undefined : rest
}
