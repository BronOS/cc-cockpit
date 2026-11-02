// `ccc plugin new <dir>` (plan B Task 6): scaffold a plugin that links and runs as it is.
//
// Plain JavaScript with no build step, on purpose: plugins ship built JS (design §5), so a fresh
// scaffold must work without `npm install` or a toolchain (Claude in a tab has none to hand, and
// the walkthrough test needs none). The guide says TypeScript is an option for later.
//
// Pure CLI, no socket: it needs nothing from the app, so it works with the app closed. The
// template files are bundled into the CLI with `?raw` (like the guide topics), because the CLI
// runs from the app bundle with no source tree next to it.
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { skillNameProblem } from '../main/plugins/skill-files'
import { CLI_NAME_PATTERN, PLUGIN_ID_MAX_LENGTH, PLUGIN_ID_PATTERN, RESERVED_CLI_NAMES, SKILL_ID_PATTERN } from '../shared/manifest'
import hostTemplate from './plugin-template/host.js.tmpl?raw'
import panelHtmlTemplate from './plugin-template/panel.html.tmpl?raw'
import panelJsTemplate from './plugin-template/panel.js.tmpl?raw'
import readmeTemplate from './plugin-template/readme.md.tmpl?raw'
import skillTemplate from './plugin-template/skill.md.tmpl?raw'

export interface PluginNewOptions {
  /** Absolute folder to create the plugin in: missing, or holding none of the files the scaffold writes. */
  dir: string
  /** Default: `local.<folder name>`. */
  id?: string
  panel: boolean
  /** A command name for `contributes.cli` (`ccc <name> …`). */
  cli?: string
  skill: boolean
}

export interface PluginNewResult {
  id: string
  dir: string
  /** Paths relative to `dir`, in the order written. */
  files: string[]
}

/** A refusal with a message for the person or Claude (exit 1); never a crash. */
export class PluginNewError extends Error {}

/** `local.<slug>` from a folder name, or undefined when the name has no usable letters. */
export function defaultPluginId(dir: string): string | undefined {
  const slug = basename(dir)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  // A manifest id's last segment must start with a letter.
  return /^[a-z]/.test(slug) ? `local.${slug}`.slice(0, PLUGIN_ID_MAX_LENGTH) : undefined
}

/**
 * The scaffold's skill id: the command name, else the plugin id's last segment. A last segment may
 * be longer than a skill id may (64 characters, SKILL_ID_PATTERN; review finding: a 65-character
 * one made a scaffold whose manifest failed validation), so it is cut to fit; it starts with a
 * letter and has only lowercase letters, digits and `-`, so any prefix of it is a valid skill id.
 * Exported for the tests.
 */
export function scaffoldSkillId(id: string, cli: string | undefined): string {
  return cli ?? (id.split('.').pop() as string).slice(0, MAX_SKILL_ID_LENGTH)
}

/** SKILL_ID_PATTERN's length: a first character and up to 63 more. */
const MAX_SKILL_ID_LENGTH = 64

/**
 * A filesystem call of the scaffold, its error (EACCES, ENOSPC, a file created meanwhile: EEXIST)
 * turned into a refusal naming the path: without it the error escaped runPluginNew and `ccc` exited
 * 0 with nothing printed (review finding). `partial`: files were already written, so the folder
 * holds a part of the scaffold that the person should remove before trying again.
 */
function fsStep<T>(what: string, path: string, partial: boolean, fn: () => T): T {
  try {
    return fn()
  } catch (err) {
    throw fsProblem(what, path, partial, err)
  }
}

function fsProblem(what: string, path: string, partial: boolean, err: unknown): PluginNewError {
  const e = err as NodeJS.ErrnoException
  const why = e.code === 'EEXIST' ? 'it appeared while the plugin was being created' : e.message
  const rest = partial ? '; the folder holds a partial scaffold: remove it and run ccc plugin new again' : ''
  return new PluginNewError(`cannot ${what} ${path}: ${why}${rest}`)
}

/** "my-tool" -> "My tool": the display name for an id's last segment. */
function displayName(id: string): string {
  const last = (id.split('.').pop() as string).replace(/-+/g, ' ')
  return last.charAt(0).toUpperCase() + last.slice(1)
}

/** Keep the lines of a `//#flag` block when the flag is on, drop them otherwise; strip the marker. */
function applyFlags(text: string, flags: Record<string, boolean>): string {
  return text
    .split('\n')
    .flatMap((line) => {
      // Exactly one space after the flag is the separator: the rest is the line's own indentation
      // (a bare marker and a one-space strip once made the generated dist/host.js mix indents).
      const m = /^\/\/#(\w+) ?/.exec(line)
      if (!m) return [line]
      return flags[m[1] as string] ? [line.slice(m[0].length)] : []
    })
    .join('\n')
}

function fill(text: string, values: Record<string, string>): string {
  return text.replace(/__(NAME|ID|CLI|SKILL|EXTRA)__/g, (_, key: string) => values[key] ?? '')
}

/**
 * Create the plugin. Refuses (PluginNewError) a file the scaffold would overwrite, a path that is not a folder, a bad id
 * or command name; nothing is written before every check passed, and files are created with
 * `wx` so a file that appeared meanwhile is never overwritten.
 */
export function scaffoldPlugin(options: PluginNewOptions): PluginNewResult {
  const id = options.id ?? defaultPluginId(options.dir)
  if (id === undefined) {
    throw new PluginNewError(`cannot make a plugin id from the folder name ${JSON.stringify(basename(options.dir))}; pass --id <id>`)
  }
  if (id.length > PLUGIN_ID_MAX_LENGTH || !PLUGIN_ID_PATTERN.test(id)) {
    throw new PluginNewError(`not a plugin id: ${id} (lowercase, dot-separated, like acme.todo)`)
  }
  const { cli } = options
  if (cli !== undefined && (RESERVED_CLI_NAMES.includes(cli) || !CLI_NAME_PATTERN.test(cli))) {
    throw new PluginNewError(`${cli} is not a usable command name`)
  }
  // The folder may exist, be empty or hold anything (a parent plugin around a nested one, or a
  // nested plugin inside a plugin); the refusal is per file, after the manifest is built below.
  let st: ReturnType<typeof statSync> | undefined
  try {
    st = statSync(options.dir)
  } catch (err) {
    // Missing is the usual case (the scaffold makes it); anything else (EACCES on a parent) is said.
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') throw fsProblem('look at', options.dir, false, err)
    st = undefined
  }
  if (st !== undefined && !st.isDirectory()) throw new PluginNewError(`${options.dir} exists and is not a folder`)

  const name = displayName(id)
  const skillId = scaffoldSkillId(id, cli)
  // Every id rule the validator applies, so the scaffold never writes a manifest it would refuse.
  if (options.skill && !SKILL_ID_PATTERN.test(skillId)) throw new PluginNewError(`cannot make a skill id from ${id}; pass --cli <name>`)
  // And the SKILL.md rule: `acme.no --skill` would scaffold a skill `no`, which YAML reads as false
  // and the app would then refuse to load.
  const nameProblem = options.skill ? skillNameProblem(skillId) : null
  if (nameProblem !== null) throw new PluginNewError(`${nameProblem}; pass --cli <another name>`)
  const contributes: Record<string, unknown> = {}
  if (options.panel) contributes.panels = [{ id: 'main', title: name, entry: 'panels/main.html', defaultZone: 'right' }]
  if (cli !== undefined) contributes.cli = [{ name: cli, summary: `Run the ${name} plugin's command`, usage: `${cli} [words...]` }]
  if (options.skill) contributes.skills = [{ id: skillId, dir: `skills/${skillId}` }]
  const manifest = {
    id,
    name,
    version: '0.1.0',
    api: 1,
    main: 'dist/host.js',
    ...(Object.keys(contributes).length > 0 ? { contributes } : {})
  }

  const extra = [
    options.panel ? '- `panels/main.html`, `panels/main.js`: the panel page (`ccc guide panels`).' : '',
    cli !== undefined ? `- \`ccc ${cli}\`: a command this plugin adds, handled in \`dist/host.js\`.` : '',
    options.skill ? `- \`skills/${skillId}/SKILL.md\`: the Claude skill the plugin brings.` : ''
  ]
    .filter((l) => l !== '')
    .join('\n')
  const values = { NAME: name, ID: id, CLI: cli ?? '', SKILL: skillId, EXTRA: extra }
  const out: Array<[string, string]> = [
    ['plugin.json', `${JSON.stringify(manifest, null, 2)}\n`],
    ['dist/host.js', fill(applyFlags(hostTemplate, { panel: options.panel, cli: cli !== undefined }), values)]
  ]
  if (options.panel) {
    out.push(['panels/main.html', fill(panelHtmlTemplate, values)], ['panels/main.js', panelJsTemplate])
  }
  if (options.skill) out.push([`skills/${skillId}/SKILL.md`, fill(skillTemplate, values)])
  // No double blank line where __EXTRA__ was empty.
  out.push(['README.md', fill(readmeTemplate, values).replace(/\n{3,}/g, '\n\n')])

  // Refuse only what would be overwritten, naming every such file, before writing anything.
  const clash = out.map(([rel]) => rel).filter((rel) => existsSync(join(options.dir, rel)))
  if (clash.length > 0) {
    throw new PluginNewError(`${options.dir} already has ${clash.join(', ')}; the scaffold would overwrite ${clash.length === 1 ? 'it' : 'them'}`)
  }

  let written = 0
  for (const [rel, text] of out) {
    const file = join(options.dir, rel)
    fsStep('create the folder', dirname(file), written > 0, () => mkdirSync(dirname(file), { recursive: true }))
    fsStep('write', file, written > 0, () => writeFileSync(file, text, { flag: 'wx' }))
    written++
  }
  return { id, dir: options.dir, files: out.map(([rel]) => rel) }
}

/** Where `ccc plugin new` writes (the CLI's stdout and stderr). */
export interface PluginNewOutput {
  stdout(text: string): void
  stderr(text: string): void
}

/**
 * `ccc plugin new …` as the CLI runs it (like runPluginLogs for `logs`): scaffold into
 * `options.dir` (already absolute), print what was made and the next steps; the exit code. A
 * refusal, a filesystem error included, is printed with exit 1; anything else thrown is a bug and
 * propagates (run() then prints it and exits 1, as for every unexpected error of a user command).
 */
export function runPluginNew(options: PluginNewOptions, out: PluginNewOutput): number {
  try {
    const made = scaffoldPlugin(options)
    // Say what the bare scaffold does not have: in the first manual test a plain `plugin new demo`
    // was followed by `ccc demo` ("unknown command"), since only `--cli` adds a command.
    const left = [
      options.panel ? '' : 'a panel (--panel)',
      options.cli !== undefined ? '' : 'a ccc command (--cli <name>)',
      options.skill ? '' : 'a Claude skill (--skill)'
    ].filter((l) => l !== '')
    out.stdout(
      `created plugin ${made.id} in ${made.dir}\n${made.files.map((f) => `  ${f}`).join('\n')}\n` +
        (left.length > 0
          ? `left out: ${left.join(', ')}; add them by hand (ccc guide plugins) or scaffold again with the flags\n`
          : '') +
        `next: ccc plugin link ${made.dir}   (the app asks the person to allow it)\n` +
        (options.cli !== undefined ? `then try: ccc ${options.cli}\n` : '') +
        `then edit the files: the app reloads the plugin by itself; ccc plugin logs ${made.id} shows its log\n`
    )
    return 0
  } catch (err) {
    if (!(err instanceof PluginNewError)) throw err
    out.stderr(`ccc: ${err.message}\n`)
    return 1
  }
}
