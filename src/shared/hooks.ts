// The Claude hook events the cockpit listens to (plan: Technical Details > `ccc` wrapper and
// hooks.json). Shared by the generator of `hooks.json` (main) and the `ccc hook` argument parser
// (CLI), so the two can never drift: a hook command is written for exactly the events the CLI
// accepts. Pure data, no imports.

export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'Stop',
  'SessionEnd'
] as const

export type HookEvent = (typeof HOOK_EVENTS)[number]

export function isHookEvent(value: string): value is HookEvent {
  return (HOOK_EVENTS as readonly string[]).includes(value)
}

/**
 * Tool matchers, for the events that have one. `PreToolUse` fires for every tool so the strip can
 * show the current tool; `PostToolUse` only for the tools that change a file (the changed-files
 * list). The other events have no matcher and fire always.
 */
export const HOOK_MATCHERS: Partial<Record<HookEvent, string>> = {
  PreToolUse: '*',
  PostToolUse: 'Edit|Write|MultiEdit|NotebookEdit'
}
