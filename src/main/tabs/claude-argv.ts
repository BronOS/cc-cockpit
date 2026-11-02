// argv builders for the tab kinds. Pure: the tab manager decides the values, this decides
// the shape. Exec is argv-only (CLAUDE.md), so the prompt and the session id each travel as one
// argument and are never parsed by a shell.

/**
 * Whether `claude` accepts a positional prompt after a `--` end-of-options marker.
 *
 * Finding (Task 7), claude 2.1.312: `claude --help` shows `Usage: claude [options] [command]
 * [prompt]`, `Arguments: prompt  Your prompt`, `--settings <file-or-json>` and
 * `-r, --resume [value]`, in commander.js layout, and commander treats `--` as the end of
 * options for every program. It matters because variadic options such as `--add-dir
 * <directories...>` would otherwise swallow a prompt placed after them, and a prompt that starts
 * with `-` would be read as a flag. Without a TTY `claude --help` cuts itself off after 20
 * lines; run it under a PTY (`script -q /dev/null claude --help`) to see all of it. The `--`
 * behaviour was NOT exercised by running a session (that would start one); test/fixtures/bin/claude
 * records the same finding. If a real run shows `--` is not accepted, set this to false:
 * `claudeArgv` then passes the prompt bare and refuses a prompt starting with `-`.
 */
export const PROMPT_AFTER_DOUBLE_DASH = true

/**
 * A Claude session id is a UUID today. It arrives from a hook payload, which is only
 * "untrusted-ish" (a tab's token proves who sent it, not that the content is sane), and ends up
 * as the value of `--resume`, so anything that is not a plain token is refused rather than
 * risking a value that starts with `-` being read as an option.
 */
export const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

export interface ClaudeArgvOptions {
  /** `<data>/hooks.json`, passed as `--settings` so the user's own settings are never touched. */
  hooksPath: string
  /**
   * Generated Claude Code plugin folders (`<data>/claude-plugins/<child>`, see
   * claude-plugins/claude-plugins.ts), each passed as its own `--plugin-dir <dir>` pair, in the
   * order given. Absolute paths only: a value starting with `-` would be read as an option.
   */
  pluginDirs?: readonly string[]
  /** Resume this session (`--resume <id>`), e.g. on restart or restore. */
  resumeId?: string
  /** Initial prompt, passed as a positional argument and never typed into the session. */
  prompt?: string
  /** Injectable for tests; production uses PROMPT_AFTER_DOUBLE_DASH. */
  doubleDash?: boolean
}

export function claudeArgv(options: ClaudeArgvOptions): string[] {
  const { hooksPath, pluginDirs = [], resumeId, prompt, doubleDash = PROMPT_AFTER_DOUBLE_DASH } = options
  const argv = ['claude', '--settings', hooksPath]
  // Right after --settings and before --resume / `--`, so the order is the same for a fresh tab,
  // a restart and a restore (tests and the e2e compare whole argv arrays).
  for (const dir of pluginDirs) {
    if (!dir.startsWith('/')) throw new Error('a Claude plugin dir must be an absolute path')
    argv.push('--plugin-dir', dir)
  }
  if (resumeId !== undefined) {
    if (!SESSION_ID.test(resumeId)) throw new Error('invalid Claude session id')
    argv.push('--resume', resumeId)
  }
  if (prompt) {
    if (doubleDash) {
      // Leading space: commander dispatches operands[0] to a subcommand even after `--`, so a
      // prompt of exactly `update`, `purge`, `rm`, `doctor`... would run that command. A space
      // keeps `_findCommand` from matching and does not change the prompt's meaning.
      argv.push('--', ' ' + prompt)
    } else {
      // No end-of-options marker to hide behind: a leading `-` would be parsed as a flag, which
      // lets whoever supplied the prompt inject options (e.g. a different --settings).
      if (prompt.startsWith('-')) {
        throw new Error('this claude does not support `--`; a prompt may not start with "-"')
      }
      argv.push(prompt)
    }
  }
  return argv
}

/** A shell tab: the user's login shell, as a login shell (`$SHELL -l`). */
export function shellArgv(shell: string): string[] {
  return [shell, '-l']
}

/**
 * A command tab (the user's new-tab menu entry, src/main/tabs/tab-commands.ts): the login shell
 * runs the command line as if the user typed it into a terminal, with the same flags as the
 * login-env capture (login-env.ts): `-l` for the login profile, `-i` so .zshrc / .bashrc aliases
 * and functions work too, `-c` for the command.
 *
 * Not a shell-injection path, although a shell parses `command`: the text is the user's own
 * setting (Settings, or their own settings file), never renderer, plugin or hook input. main
 * looks it up by entry id (TabCommandsService.resolve) and nothing else reaches here. It still
 * travels as ONE argv element, never spliced into another string, so the shell parses exactly
 * what the user wrote and nothing around it.
 */
export function commandArgv(shell: string, command: string): string[] {
  return [shell, '-l', '-i', '-c', command]
}

/**
 * The user's login shell, for shell and command tabs and command overlays alike: the captured
 * login env's SHELL, else the app's own (a capture that failed), else /bin/sh.
 */
export function loginShellOf(loginEnv: { SHELL?: string }): string {
  return loginEnv.SHELL || process.env.SHELL || '/bin/sh'
}

/**
 * The terminal overlay of a new-tab menu entry that opens as an overlay (`open: 'overlay'`): the
 * same argv as its tab would run (commandArgv), in the project folder, titled by the label (not the
 * default title, the argv joined, which would read `/bin/zsh -l -i -c lazygit`). The caller got
 * `entry` from TabCommandsService.resolve, i.e. by id from the user's own settings.
 */
export function commandOverlaySpec(
  shell: string,
  entry: { label: string; command: string },
  projectDir: string
): { kind: 'terminal'; argv: string[]; cwd: string; title: string; size: 'full' } {
  return { kind: 'terminal', argv: commandArgv(shell, entry.command), cwd: projectDir, title: entry.label, size: 'full' }
}
