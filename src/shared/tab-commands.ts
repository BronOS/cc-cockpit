// Limits and checks of the user's new-tab menu entries (TabCommandEntry, design §3 Tabs "Custom
// commands"), and the keybinding command id of each entry. Pure and import-free so the renderer
// can size its fields with the same numbers main enforces and read an entry back out of a command
// id; main (src/main/tabs/tab-commands.ts) is the one that decides.

/** A label is a menu item and a tab title: one short line. */
export const TAB_COMMAND_LABEL_MAX = 60
/** Far above any real command line, far below what an argv element may hold (macOS ARG_MAX 1 MiB). */
export const TAB_COMMAND_MAX = 4096
/** Per level (app-wide, per project): a menu longer than this is no longer a menu. */
export const TAB_COMMANDS_MAX = 50

/**
 * What an entry id may look like: a UUID today, anything token-like from an older or hand-edited
 * file. Never a `.` or a `/`: the command id below splits on the dots, and a `/` is what marks a
 * plugin command (CommandRegistry, the `commands.run` gate), which an entry must never pass for.
 */
export const TAB_COMMAND_ENTRY_ID = /^[A-Za-z0-9_-]{1,64}$/

const COMMAND_ID_PREFIX = 'tab.newCommand.'

/**
 * The keybinding command of an entry: `tab.newCommand.app.<entryId>` or
 * `tab.newCommand.project.<entryId>` (the `tab.` area of the core tab commands). Derived from the
 * level and the id main minted, not the label, so a rename keeps the user's chord. The
 * overrides in `app.json` are app-wide; a project entry's id is a UUID, so it does not meet
 * another project's (two hand-edited projects that both say `lazygit` would share one chord).
 */
export function tabCommandId(level: 'app' | 'project', entryId: string): string {
  return `${COMMAND_ID_PREFIX}${level}.${entryId}`
}

/**
 * The entry a command id names, or undefined for any other id. Only the shape is checked here;
 * whether the entry exists is main's call when the tab is created (TabCommandsService.resolve).
 */
export function parseTabCommandId(id: string): { level: 'app' | 'project'; entryId: string } | undefined {
  if (!id.startsWith(COMMAND_ID_PREFIX)) return undefined
  const rest = id.slice(COMMAND_ID_PREFIX.length)
  const dot = rest.indexOf('.')
  if (dot < 0) return undefined
  const level = rest.slice(0, dot)
  const entryId = rest.slice(dot + 1)
  if (level !== 'app' && level !== 'project') return undefined
  if (!TAB_COMMAND_ENTRY_ID.test(entryId)) return undefined
  return { level, entryId }
}

/**
 * The title of an entry's command, in the keybinding list and the palette. An overlay entry says
 * so: "New tab:" would promise a tab it does not open. The command id stays `tab.newCommand.*`
 * either way, so switching an entry between Tab and Overlay keeps the user's chord.
 */
export function tabCommandTitle(label: string, open?: 'tab' | 'overlay'): string {
  return open === 'overlay' ? `Overlay: ${label}` : `New tab: ${label}`
}

// C0 controls and DEL. A label is shown on one line in the menu and the tab strip; a newline or an
// escape byte there is a damaged file, not something the user meant.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/

/**
 * The label as stored (trimmed), or the reason it is refused. Length is counted in UTF-16 code
 * units, like the field's `maxLength`, so the page and main agree on the limit.
 */
export function checkTabCommandLabel(value: unknown): { ok: true; value: string } | { ok: false; reason: string } {
  if (typeof value !== 'string') return { ok: false, reason: 'the label must be text' }
  const label = value.trim()
  if (label.length === 0 || label.length > TAB_COMMAND_LABEL_MAX) {
    return { ok: false, reason: `the label must be 1-${TAB_COMMAND_LABEL_MAX} characters` }
  }
  if (CONTROL.test(label)) return { ok: false, reason: 'the label must be one line of plain text' }
  return { ok: true, value: label }
}

/**
 * The command line as stored (trimmed), or the reason it is refused. NUL is refused: it cannot
 * travel in an argv element (the C string would end there, running a different command than the
 * one shown). Newlines are allowed: the shell runs a multi-line command as typed.
 */
export function checkTabCommandLine(value: unknown): { ok: true; value: string } | { ok: false; reason: string } {
  if (typeof value !== 'string') return { ok: false, reason: 'the command must be text' }
  const command = value.trim()
  if (command.length === 0 || command.length > TAB_COMMAND_MAX) {
    return { ok: false, reason: `the command must be 1-${TAB_COMMAND_MAX} characters` }
  }
  if (command.includes('\0')) return { ok: false, reason: 'the command may not contain a NUL character' }
  return { ok: true, value: command }
}

/**
 * Where an entry runs, from a stored or submitted value: `'overlay'` for exactly that; absent,
 * `'tab'` and anything else (a typo in a hand-edited file, a number) are a tab, so a file from
 * before the field, or a damaged one, keeps opening tabs. Lenient on save as well: the value only
 * decides where the entry's own command shows, never what runs, so it is not worth refusing a list.
 */
export function checkTabCommandOpen(value: unknown): 'tab' | 'overlay' {
  return value === 'overlay' ? 'overlay' : 'tab'
}

/** A plugin command tab's argv (ctx.sessions.openCommand): far more than any real command needs. */
export const COMMAND_ARGV_MAX = 64

/**
 * A plugin command tab's argv as stored (a copy), or the reason it is refused: 1-64 strings, each
 * 1-4096 characters (TAB_COMMAND_MAX) with no NUL. Nothing is trimmed: the argv is spawned as is,
 * with no shell, so a leading space is part of an argument and must not be silently dropped. NUL is
 * refused for the reason checkTabCommandLine gives: the C string would end there, running another
 * argument than the one the tab shows. An empty element is refused too: no real program wants one,
 * and an empty argv[0] would only fail the spawn later with a less useful error.
 */
export function checkCommandArgv(value: unknown): { ok: true; value: string[] } | { ok: false; reason: string } {
  if (!Array.isArray(value) || value.length === 0 || value.length > COMMAND_ARGV_MAX) {
    return { ok: false, reason: `argv must be an array of 1-${COMMAND_ARGV_MAX} strings` }
  }
  const out: string[] = []
  for (const arg of value as unknown[]) {
    if (typeof arg !== 'string') return { ok: false, reason: 'argv must hold strings only' }
    if (arg.length === 0 || arg.length > TAB_COMMAND_MAX) {
      return { ok: false, reason: `each argv element must be 1-${TAB_COMMAND_MAX} characters` }
    }
    if (arg.includes('\0')) return { ok: false, reason: 'argv may not contain a NUL character' }
    out.push(arg)
  }
  return { ok: true, value: out }
}

/**
 * An argv as one line for a tooltip: plain words as they are, a word with a space, a quote, a
 * backslash or a control character (or an empty one) in single quotes, `'` written as `'\''`, and
 * control characters as `\xNN`, so `['sh', '-c', 'echo $1', 'sh', 'x y']` reads
 * `sh -c 'echo $1' sh 'x y'` and a newline in an argument cannot fake a second tooltip line.
 * Display only: nothing parses it back.
 */
export function argvText(argv: readonly string[]): string {
  return argv
    .map((arg) => {
      // eslint-disable-next-line no-control-regex
      const shown = arg.replace(/[\u0000-\u001f\u007f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`)
      return arg !== '' && /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? shown : `'${shown.replace(/'/g, `'\\''`)}'`
    })
    .join(' ')
}

/**
 * The title of a plugin command tab opened without one: the last path part of argv[0]
 * (`/usr/local/bin/glow` reads `glow`), made a valid label: control characters dropped, trimmed,
 * cut to TAB_COMMAND_LABEL_MAX; `Command` when nothing is left (argv[0] `/`).
 */
export function defaultCommandTitle(argv0: string): string {
  const base = argv0.replace(/\/+$/, '').split('/').pop() ?? ''
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, TAB_COMMAND_LABEL_MAX).trim()
  return clean === '' ? 'Command' : clean
}
