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
 * Tools whose call IS a dialog on Claude's screen that the user answers: Claude is blocked on the
 * user from the tool's PreToolUse until the dialog is answered, exactly as in a permission prompt,
 * and an Enter typed by the send gate would pick an option. The reducer puts the tab in
 * `needs-permission` on their PreToolUse (status-reducer.ts); the renderer words it "needs you".
 *
 * Verified in claude 2.1.316 (the bundled source in the binary, no live session): these are the
 * tools of the terminal CLI whose definition says `requiresUserInteraction() -> true`:
 * AskUserQuestion (the question dialog) and ExitPlanMode (plan approval). The binary has a few
 * more such tools (ShowOnboardingRolePicker, OfferChromeSetup, PublishPlugin, SendToProject, a
 * task-file save); they belong to other surfaces (Cowork, the desktop and web apps) and are left
 * out until one is seen in a terminal. EnterPlanMode asks through the ordinary permission flow
 * ("Enter plan mode?"), which Notification(permission_prompt) already covers. Tools that raise
 * no dialog never go here: needs-permission holds the send queue for as long as it lasts.
 */
export const DIALOG_TOOLS = ['AskUserQuestion', 'ExitPlanMode'] as const

export type DialogTool = (typeof DIALOG_TOOLS)[number]

export function isDialogTool(tool: unknown): tool is DialogTool {
  return typeof tool === 'string' && (DIALOG_TOOLS as readonly string[]).includes(tool)
}

/**
 * Tool matchers, for the events that have one. `PreToolUse` fires for every tool so the strip can
 * show the current tool; `PostToolUse` only for the tools that change a file (the changed-files
 * list) and the dialog tools, whose PostToolUse is the one sign that their dialog was answered (the
 * tool ends the moment it is). The other events have no matcher and fire always.
 */
export const HOOK_MATCHERS: Partial<Record<HookEvent, string>> = {
  PreToolUse: '*',
  PostToolUse: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', ...DIALOG_TOOLS].join('|')
}
