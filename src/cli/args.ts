// `ccc` argument parsing (plan: Task 13 for `hook`, Task 21 for the rest).
//
// Parsing never throws and never prints: this process must never fail a Claude hook, so a `hook`
// line it cannot make sense of is `{ kind: 'none' }` and the caller exits 0 without doing
// anything. The user-facing commands are different: a mistyped one gets a `usage` message (stderr,
// exit 2), because silence would hide a typo from the person or the skill running it. Neither is
// the "app not running" case, which every command answers with a silent exit 0 (client.ts).
//
// Paths stay as typed here (possibly relative); client.ts resolves them against its own cwd,
// because main's cwd means nothing to the caller.
//
// One table (CORE_COMMANDS) holds each core command's parser and its usage lines: dispatch, the
// whole USAGE text and `ccc <command> --help` all come from it, and its keys are typed by
// CORE_CLI_COMMANDS (src/shared/manifest.ts), the list main reserves against plugin command names.
import { isHookEvent, type HookEvent } from '../shared/hooks'
import { MAX_PLUGIN_CONFIG_EDITS, parseConfigValue, PLUGIN_CONFIG_SCOPES, type PluginConfigScope } from '../shared/plugin-config'
import {
  CLI_NAME_PATTERN,
  type CoreCliCommand,
  CORE_CLI_COMMANDS,
  isCoreCliCommand,
  PLUGIN_ID_MAX_LENGTH,
  PLUGIN_ID_PATTERN,
  RESERVED_CLI_NAMES
} from '../shared/manifest'

/** What `ccc overlay` shows. Exactly one of the three. */
export type OverlayTarget =
  | { mode: 'terminal'; argv: string[] }
  | { mode: 'url'; url: string }
  | { mode: 'html'; file: string }

export type Command =
  | { kind: 'hook'; event: HookEvent }
  | { kind: 'open'; path: string }
  | { kind: 'note'; text: string }
  | { kind: 'steps'; done: number; total: number }
  | { kind: 'overlay'; project?: string; target: OverlayTarget }
  | { kind: 'sessions'; json: boolean }
  | { kind: 'notify'; text: string }
  | { kind: 'help'; command?: string }
  | { kind: 'guide'; topic?: string }
  /**
   * A command a plugin adds (plan B Task 5): any first word that is no core command and has the
   * plugin command name shape. `argv` is the rest, verbatim (the plugin parses it), except a
   * leading `--help`/`-h`, which the CLI answers itself from the manifest usage (the plugin never
   * sees it); `project` is a leading `--project <path>`, for a call from outside a tab.
   */
  | { kind: 'plugin'; name: string; argv: string[]; project?: string }
  /**
   * The plugin dev loop (plan B Task 6), `ccc plugin new|link|unlink|list|logs`. `new` and `logs`
   * run in the CLI alone (no app); the others are one request each. `project` is a `--project
   * <path>` after the subcommand, for a call from outside a tab.
   */
  | { kind: 'plugin-new'; dir: string; id?: string; panel: boolean; cli?: string; skill: boolean }
  | { kind: 'plugin-link'; dir: string; project?: string }
  | { kind: 'plugin-unlink'; id: string; project?: string }
  | { kind: 'plugin-list'; json: boolean; project?: string }
  | { kind: 'plugin-logs'; id: string; follow: boolean }
  /**
   * `ccc plugin config <id>` (friction round 1, Task 6): no `set` prints the plugin's settings;
   * `set` holds the `key=value` arguments, each value parsed as JSON or kept as text
   * (parseConfigValue). `scope` is `--scope app|project`, only with `set`.
   */
  | { kind: 'plugin-config'; id: string; json: boolean; scope?: PluginConfigScope; set: Array<[string, unknown]>; project?: string }
  /** `ccc panel show <plugin>/<panel>` (friction round 1, Task 7). */
  | { kind: 'panel-show'; plugin: string; panel: string; project?: string }
  | { kind: 'usage'; message: string }
  | { kind: 'none' }

/** The column every usage description starts at (`ccc help` lists plugin commands at it too). */
export const USAGE_COLUMN = 43

/** One entry of the usage text: its synopsis lines (what follows `ccc `) and its description lines. */
export interface UsageEntry {
  synopsis: readonly string[]
  text: readonly string[]
}

/**
 * An entry as usage lines: each synopsis on its own line, the description from USAGE_COLUMN. The
 * first description line goes on the last synopsis line when at least two spaces are left there.
 */
export function formatUsageEntry(entry: UsageEntry): string {
  const indent = ' '.repeat(USAGE_COLUMN)
  const heads = entry.synopsis.map((s) => `  ccc ${s}`)
  const last = heads.pop() ?? '  ccc'
  const [first, ...more] = entry.text
  const lines = [...heads]
  if (first !== undefined && last.length + 2 <= USAGE_COLUMN) lines.push(`${last.padEnd(USAGE_COLUMN)}${first}`)
  else lines.push(last, ...(first === undefined ? [] : [`${indent}${first}`]))
  for (const t of more) lines.push(`${indent}${t}`)
  return lines.join('\n')
}

interface CoreCommand {
  parse(rest: readonly string[]): Command
  /** Empty for `hook`: it is internal, never listed and has no `--help` (it never prints). */
  usage: readonly UsageEntry[]
}

/** Every core command; the mapped type makes a missing or an unknown key a type error. */
const CORE_COMMANDS: { readonly [C in CoreCliCommand]: CoreCommand } = {
  open: {
    parse: (rest) => {
      const [path, ...extra] = rest
      if (path === undefined || path === '' || extra.length > 0) return usage('open takes one folder path')
      return { kind: 'open', path }
    },
    usage: [{ synopsis: ['open <path>'], text: ['open (or focus) a folder as a project'] }]
  },
  panel: {
    parse: (rest) => parsePanel(rest),
    usage: [
      {
        synopsis: ['panel show [--project <path>] <plugin>/<panel>'],
        text: ["reveal a plugin's panel in this project's window (unhide, open, expand);", '--project names an open folder when run outside a tab']
      }
    ]
  },
  hook: {
    parse: (rest) => {
      const [event, ...extra] = rest
      // Exactly `hook <Event>`: a hook command line is generated by us (hooks-file.ts) and has
      // nothing else, so extra arguments mean a hand-typed call and are not guessed at.
      return event !== undefined && extra.length === 0 && isHookEvent(event) ? { kind: 'hook', event } : { kind: 'none' }
    },
    usage: []
  },
  session: {
    parse: (rest) => parseSession(rest),
    usage: [
      { synopsis: ['session note <text>'], text: ["add a note to this tab's Claude session (in a Claude tab)"] },
      { synopsis: ['session steps <done>/<total>'], text: ['set its progress, e.g. 3/5 (in a Claude tab)'] }
    ]
  },
  overlay: {
    parse: (rest) => parseOverlay(rest),
    usage: [
      {
        synopsis: [
          'overlay [--project <path>] --terminal -- <argv...>',
          'overlay [--project <path>] --url <http(s) url>',
          'overlay [--project <path>] --html <file>'
        ],
        text: ['show an overlay; waits and prints the result as JSON.', '--project names an open folder when run outside a tab']
      }
    ]
  },
  sessions: {
    parse: (rest) => {
      if (rest.length === 0) return { kind: 'sessions', json: false }
      if (rest.length === 1 && rest[0] === '--json') return { kind: 'sessions', json: true }
      return usage('sessions takes only --json')
    },
    usage: [{ synopsis: ['sessions [--json]'], text: ['the Claude tabs of every window'] }]
  },
  notify: {
    parse: (rest) => {
      const text = words(rest)
      return text === undefined ? usage('notify needs some text') : { kind: 'notify', text }
    },
    usage: [{ synopsis: ['notify <text>'], text: ['show a system notification'] }]
  },
  guide: {
    parse: (rest) => {
      if (rest.length > 1) return usage('guide takes at most one topic')
      return rest[0] === undefined ? { kind: 'guide' } : { kind: 'guide', topic: rest[0] }
    },
    usage: [
      {
        synopsis: ['guide [topic]'],
        text: ['print the built-in docs (overview, cli, plugins, api, ...); works', 'with the app closed']
      }
    ]
  },
  plugin: {
    parse: (rest) => parsePluginDev(rest),
    usage: [
      {
        synopsis: ['plugin new <dir> [--id <id>] [--panel] [--cli <name>] [--skill]'],
        text: ['scaffold a plain-JS plugin (no build step) in an empty folder']
      },
      {
        synopsis: ['plugin link [--project <path>] <dir>'],
        text: ['link a plugin folder and enable it in this project; a', 'confirm dialog in the app asks the person first']
      },
      { synopsis: ['plugin unlink [--project <path>] <id>'], text: ['unlink a linked plugin'] },
      { synopsis: ['plugin list [--project <path>] [--json]'], text: ['the installed plugins and whether they are enabled here'] },
      {
        synopsis: ['plugin config [--project <path>] <id> [--json]', 'plugin config [--project <path>] <id> [--scope app|project] <key>=<value>...'],
        text: [
          "print a plugin's app and project settings, or set top-level",
          'fields (value: JSON, else text); secret fields only in Settings'
        ]
      },
      { synopsis: ['plugin logs <id> [--follow]'], text: ["print a plugin's log (the last lines; --follow keeps going)"] }
    ]
  },
  help: {
    parse: () => ({ kind: 'help' }),
    usage: [{ synopsis: ['help'], text: ["this text; ccc <command> --help shows one command's lines"] }]
  }
}

/** The plugin command line of USAGE: not a core command, listed before `help`. */
const PLUGIN_COMMAND_USAGE: UsageEntry = {
  synopsis: ['[--project <path>] <plugin command> [args...]'],
  text: [
    'a command a plugin of this project adds (listed below',
    'when run in a tab); --project names an open folder',
    'when run outside a tab'
  ]
}

export const USAGE = [
  'usage:',
  ...CORE_CLI_COMMANDS.flatMap((c) => [...(c === 'help' ? [PLUGIN_COMMAND_USAGE] : []), ...CORE_COMMANDS[c].usage]).map(formatUsageEntry)
].join('\n')

/** The USAGE lines of one core command, or undefined when it has none (`hook`, a plugin command). */
export function usageFor(command: string): string | undefined {
  if (!isCoreCliCommand(command)) return undefined
  const entries = CORE_COMMANDS[command].usage
  return entries.length > 0 ? entries.map(formatUsageEntry).join('\n') : undefined
}

/** `argv` is `process.argv.slice(2)`: the arguments after the script. */
export function parseArgs(argv: readonly string[]): Command {
  const [command, ...rest] = argv
  if (command === undefined) return usage('missing command')
  if (command === '--help' || command === '-h') return { kind: 'help' }
  if (command === '--project') return parseProjectPrefix(rest)
  if (!isCoreCliCommand(command)) return pluginCommand(command, rest)
  // `ccc <command> --help` prints that command's usage lines instead of running it (`notify --help`
  // would otherwise send a notification saying "--help"). Not `hook`: it never prints.
  if ((rest[0] === '--help' || rest[0] === '-h') && CORE_COMMANDS[command].usage.length > 0) return { kind: 'help', command }
  return CORE_COMMANDS[command].parse(rest)
}

/** The core commands that take `--project`, and where (their USAGE synopses say the same). */
const PROJECT_AFTER_NAME: Partial<Record<string, string>> = {
  overlay: 'ccc overlay --project <path> ...',
  plugin: 'ccc plugin link|unlink|list|config --project <path> ...',
  panel: 'ccc panel show --project <path> <plugin>/<panel>'
}

/**
 * `ccc --project <path> <plugin command> …`: the core commands that act on a project take
 * `--project` after their name (overlay), so only a plugin command may follow it here.
 */
function parseProjectPrefix(rest: readonly string[]): Command {
  const [path, name, ...args] = rest
  if (path === undefined || path === '') return usage('--project needs a value')
  if (name === undefined) return usage('--project needs a plugin command after the path')
  // `ccc --project <path> --help` asks for the usage like `ccc --help` (review finding: it said
  // "unknown command: --help"). `ccc --project <path> <command> --help` is the plugin's own.
  if (name === '--help' || name === '-h') return { kind: 'help' }
  // A core command here is no plugin command: "unknown command: plugin" read as if `ccc plugin`
  // did not exist (review finding), so say where its --project goes, or that it takes none.
  if (isCoreCliCommand(name)) {
    const after = PROJECT_AFTER_NAME[name]
    return usage(after ? `${name} takes --project after its name: ${after}` : `${name} takes no --project (it goes before a plugin command only)`)
  }
  const parsed = pluginCommand(name, args)
  return parsed.kind === 'plugin' ? { ...parsed, project: path } : parsed
}

/**
 * A first word that is no core command: a plugin command when it has the name shape a manifest
 * may declare and is not one of the reserved names (`version` stays a typo, not a trip to main).
 * Whether a plugin of the caller's project provides it is main's to say.
 */
function pluginCommand(name: string, rest: readonly string[]): Command {
  if (RESERVED_CLI_NAMES.includes(name) || !CLI_NAME_PATTERN.test(name)) return usage(`unknown command: ${name}`)
  return { kind: 'plugin', name, argv: [...rest] }
}

/** A usage message when `id` cannot be a plugin id; the id of `logs` becomes part of a file name. */
function pluginIdProblem(id: string): string | undefined {
  if (id.length > PLUGIN_ID_MAX_LENGTH || !PLUGIN_ID_PATTERN.test(id)) {
    return `not a plugin id: ${id} (lowercase, dot-separated, like acme.todo)`
  }
  return undefined
}

type PluginSub = 'new' | 'link' | 'unlink' | 'list' | 'config' | 'logs'

/**
 * The options of each `ccc plugin` subcommand: `value` takes the next argument (the message is
 * what a missing one says), `flag` stands alone. Any other `--option` is a usage error.
 */
const PLUGIN_OPTIONS: Record<PluginSub, Readonly<Record<string, { value: string } | 'flag'>>> = {
  new: { '--id': { value: 'needs a value' }, '--cli': { value: 'needs a command name' }, '--panel': 'flag', '--skill': 'flag' },
  link: { '--project': { value: 'needs a value' } },
  unlink: { '--project': { value: 'needs a value' } },
  list: { '--project': { value: 'needs a value' }, '--json': 'flag' },
  config: { '--project': { value: 'needs a value' }, '--json': 'flag', '--scope': { value: 'needs app or project' } },
  logs: { '--follow': 'flag' }
}

function isPluginSub(sub: string): sub is PluginSub {
  return Object.hasOwn(PLUGIN_OPTIONS, sub)
}

/** `ccc plugin <sub> …`: the dev loop. A mistyped one is a usage error (exit 2), as for every user command. */
function parsePluginDev(rest: readonly string[]): Command {
  const [sub, ...args] = rest
  if (sub === undefined) return usage('plugin needs new, link, unlink, list, config or logs')
  if (!isPluginSub(sub)) return usage(`unknown plugin command: ${sub}`)
  if (args[0] === '--help' || args[0] === '-h') return { kind: 'help', command: 'plugin' }
  const options = PLUGIN_OPTIONS[sub]
  const positional: string[] = []
  const values = new Map<string, string>()
  const flags = new Set<string>()
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    const option = Object.hasOwn(options, arg) ? options[arg] : undefined
    if (option === 'flag') flags.add(arg)
    else if (option !== undefined) {
      const value = args[++i]
      if (!value) return usage(`plugin ${sub}: ${arg} ${option.value}`)
      values.set(arg, value)
    } else if (arg.startsWith('--')) return usage(`plugin ${sub}: unknown option ${arg}`)
    else positional.push(arg)
  }
  const target = positional.length === 1 && positional[0] !== '' ? (positional[0] as string) : undefined
  const project = values.get('--project')
  const withProject = <T extends object>(command: T): T => (project === undefined ? command : { ...command, project })
  switch (sub) {
    case 'new': {
      if (target === undefined) return usage('plugin new takes one folder')
      const id = values.get('--id')
      const cli = values.get('--cli')
      if (id !== undefined) {
        const problem = pluginIdProblem(id)
        if (problem !== undefined) return usage(`plugin new: ${problem}`)
      }
      if (cli !== undefined && (RESERVED_CLI_NAMES.includes(cli) || !CLI_NAME_PATTERN.test(cli))) {
        return usage(`plugin new: ${cli} is not a usable command name (lowercase letters, digits and dashes, 2-32 characters, not a core command)`)
      }
      return {
        kind: 'plugin-new',
        dir: target,
        ...(id !== undefined ? { id } : {}),
        panel: flags.has('--panel'),
        ...(cli !== undefined ? { cli } : {}),
        skill: flags.has('--skill')
      }
    }
    case 'link':
      return target === undefined ? usage('plugin link takes one folder') : withProject({ kind: 'plugin-link', dir: target })
    case 'list':
      return positional.length > 0 ? usage('plugin list takes only --json') : withProject({ kind: 'plugin-list', json: flags.has('--json') })
    case 'config': {
      const config = parsePluginConfig(positional, values.get('--scope'), flags.has('--json'))
      return config.kind === 'plugin-config' ? withProject(config) : config
    }
    case 'unlink':
    case 'logs': {
      if (target === undefined) return usage(`plugin ${sub} takes one plugin id`)
      const problem = pluginIdProblem(target)
      if (problem !== undefined) return usage(`plugin ${sub}: ${problem}`)
      return sub === 'unlink'
        ? withProject({ kind: 'plugin-unlink', id: target })
        : { kind: 'plugin-logs', id: target, follow: flags.has('--follow') }
    }
  }
}

/**
 * `ccc plugin config <id> [key=value ...]`: the id, then the edits, split at the first `=` (a value
 * may hold more). The scope flag is not `--app`/`--project`: `--project <path>` already names the
 * project folder for every `ccc plugin` subcommand, so `--project` alone would be ambiguous.
 */
function parsePluginConfig(positional: readonly string[], scope: string | undefined, json: boolean): Command {
  const [id, ...pairs] = positional
  if (id === undefined || id === '') return usage('plugin config takes a plugin id, then key=value to set')
  const problem = pluginIdProblem(id)
  if (problem !== undefined) return usage(`plugin config: ${problem}`)
  if (scope !== undefined && !PLUGIN_CONFIG_SCOPES.includes(scope as PluginConfigScope)) {
    return usage(`plugin config: --scope is app or project, not ${scope}`)
  }
  if (pairs.length > MAX_PLUGIN_CONFIG_EDITS) return usage(`plugin config: at most ${MAX_PLUGIN_CONFIG_EDITS} key=value at once`)
  const set: Array<[string, unknown]> = []
  for (const pair of pairs) {
    const eq = pair.indexOf('=')
    if (eq <= 0) return usage(`plugin config: expected key=value, got ${pair}`)
    set.push([pair.slice(0, eq), parseConfigValue(pair.slice(eq + 1))])
  }
  if (scope !== undefined && set.length === 0) return usage('plugin config: --scope goes with key=value to set')
  return { kind: 'plugin-config', id, json, ...(scope !== undefined ? { scope: scope as PluginConfigScope } : {}), set }
}

function parseSession(rest: readonly string[]): Command {
  const [sub, ...args] = rest
  if (sub === 'note') {
    const text = words(args)
    return text === undefined ? usage('session note needs some text') : { kind: 'note', text }
  }
  if (sub === 'steps') {
    const m = args.length === 1 ? /^(\d{1,7})\/(\d{1,7})$/.exec(args[0] as string) : null
    if (!m) return usage('session steps takes one argument like 3/5')
    const done = Number(m[1])
    const total = Number(m[2])
    // main checks the same (and the upper bound); failing here saves a round trip and says why.
    if (total < 1 || done > total) return usage('session steps: need 0 <= done <= total and total >= 1')
    return { kind: 'steps', done, total }
  }
  return usage(sub === undefined ? 'session needs note or steps' : `unknown session command: ${sub}`)
}

/** `ccc panel show [--project <path>] <plugin>/<panel>`: the panel key is the plugin id, a slash, the manifest's panel id. */
function parsePanel(rest: readonly string[]): Command {
  const [sub, ...args] = rest
  if (sub !== 'show') return usage(sub === undefined ? 'panel needs show' : `unknown panel command: ${sub}`)
  let project: string | undefined
  const positional: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (arg === '--project') {
      project = args[++i]
      if (!project) return usage('panel show: --project needs a value')
    } else if (arg.startsWith('--')) return usage(`panel show: unknown option ${arg}`)
    else positional.push(arg)
  }
  const key = positional.length === 1 ? (positional[0] as string) : ''
  const cut = key.lastIndexOf('/')
  if (cut <= 0 || cut === key.length - 1) return usage('panel show takes one <plugin>/<panel>, like acme.todo/list')
  const plugin = key.slice(0, cut)
  const problem = pluginIdProblem(plugin)
  if (problem !== undefined) return usage(`panel show: ${problem}`)
  return { kind: 'panel-show', plugin, panel: key.slice(cut + 1), ...(project !== undefined ? { project } : {}) }
}

function parseOverlay(rest: readonly string[]): Command {
  let project: string | undefined
  let terminal = false
  let url: string | undefined
  let html: string | undefined
  let argv: string[] | undefined
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string
    if (arg === '--') {
      // Everything after is the program and its arguments, verbatim (an argument may itself
      // start with `-`). Only `--terminal` has such a tail.
      argv = rest.slice(i + 1)
      break
    }
    const value = (): string | undefined => rest[++i]
    if (arg === '--terminal') terminal = true
    else if (arg === '--url') url = value()
    else if (arg === '--html') html = value()
    else if (arg === '--project') project = value()
    else return usage(`overlay: unknown option ${arg}`)
    // A flag at the end with no value, or with an empty one. (A value that looks like another flag
    // is taken as is: the later checks reject it as a url, file or folder.)
    if ((arg === '--url' && !url) || (arg === '--html' && !html) || (arg === '--project' && !project)) {
      return usage(`overlay: ${arg} needs a value`)
    }
  }
  const modes = [terminal, url !== undefined, html !== undefined].filter(Boolean).length
  if (modes !== 1) return usage('overlay needs exactly one of --terminal, --url, --html')
  if (terminal) {
    if (argv === undefined || argv.length === 0) return usage('overlay --terminal needs a program after --')
    return withProject({ kind: 'overlay', target: { mode: 'terminal', argv } }, project)
  }
  if (argv !== undefined) return usage('overlay: arguments after -- are for --terminal only')
  if (url !== undefined) return withProject({ kind: 'overlay', target: { mode: 'url', url } }, project)
  return withProject({ kind: 'overlay', target: { mode: 'html', file: html as string } }, project)
}

function withProject(command: Extract<Command, { kind: 'overlay' }>, project: string | undefined): Command {
  return project === undefined ? command : { ...command, project }
}

/**
 * Free text from the remaining arguments: `--` ends option parsing (so text may start with `-`),
 * several words are joined with one space (an unquoted `ccc session note fixed the build` works),
 * and blank text is nothing. The text stays ONE value from here on; it is never split again or
 * handed to a shell.
 */
function words(args: readonly string[]): string | undefined {
  const list = args[0] === '--' ? args.slice(1) : args
  const text = list.join(' ').trim()
  return text === '' ? undefined : text
}

function usage(message: string): Command {
  return { kind: 'usage', message }
}
