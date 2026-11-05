// The plugin manifest (`plugin.json`, design §5): types, the JSON Schema that describes it and the
// pure checks that need no filesystem. The manifest is untrusted input from a plugin folder, so
// every string that ends up in a path, an id or a command line is constrained here, before
// `src/main/plugins/validate.ts` (ajv, file containment, settings schemas) accepts it.
import type { ZoneId } from './layout'
import { MAX_PANEL_SLOT_TYPES, MAX_PROVIDER_SLOTS, SLOT_HEIGHT_MAX, SLOT_HEIGHT_MIN, SLOT_TYPE_PATTERN, type SlotContribution } from './slots'

export type { SlotContribution } from './slots'

/** The plugin API major this app implements; any other major is refused. */
export const SUPPORTED_PLUGIN_API = 1

/**
 * Plugin ids: reverse-DNS-ish, lower case, at least two dot-separated labels (`bronos.jira`).
 * The id becomes a directory name (`plugins/<id>@<version>`) and a URL host (`cc-plugin://<id>`),
 * so no slash, no `..` (a label cannot be empty or contain a dot) and no upper case (hosts are
 * case-insensitive; two ids differing in case must not alias). The last label must start with a
 * letter: `cc-plugin` is a standard scheme, and the WHATWG URL parser reads a host whose last label
 * is a number (`1.2`, `a.0x7f`) as IPv4, so `1.2` would become host `1.0.0.2` and share an origin
 * (and the per-plugin CSP) with a plugin called `1.0.0.2`.
 */
export const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*\.[a-z][a-z0-9-]*$/
export const PLUGIN_ID_MAX_LENGTH = 100

/**
 * Ids starting with `cockpit.` belong to the plugins that ship with the app (main/plugins/bundled.ts).
 * Bundling is an app release, not something a plugin can ask for, so every way in (link, git install,
 * marketplace install, the marketplace index tools, `ccc plugin new`) refuses one and the installer
 * loads one only from the bundled root. Third parties do the same things under their own id.
 */
export const RESERVED_PLUGIN_ID_PREFIX = 'cockpit.'
export const RESERVED_PLUGIN_ID_MESSAGE = 'ids starting with cockpit. are reserved for plugins that ship with the app'

/**
 * The one reservation rule. Compared case-insensitively and after trimming, although
 * PLUGIN_ID_PATTERN accepts only lower-case ASCII with no spaces: the rule must not depend on every
 * caller having run the pattern first (plugins.json and an index are hand-editable), and a looser
 * pattern later must not open a `Cockpit.foo` or ` cockpit.foo` door. NFKC first, the way a URL host
 * is folded: a fullwidth `ｃ` or the Kelvin sign `K` would otherwise slip past as a different string.
 */
export function isReservedPluginId(id: string): boolean {
  return id.normalize('NFKC').trim().toLowerCase().startsWith(RESERVED_PLUGIN_ID_PREFIX)
}

/**
 * The version is also part of a directory name, so it is a restricted semver: no slash, no
 * leading dot, nothing a path join could misread.
 */
export const PLUGIN_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

/**
 * Contribution ids (panel, command, theme) are namespaced at runtime as `<pluginId>/<id>`, so the
 * id itself must not contain the separator.
 */
export const CONTRIBUTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/**
 * Skill ids are stricter than other contribution ids: the id is the skill's folder name in the
 * generated Claude plugin (`skills/<id>/`), the `name:` in its SKILL.md and, to Claude, the part
 * after the colon of `<plugin>:<id>`. Claude Code's skill names are lower-case letters, digits and
 * hyphens, at most 64; no dot, so the folder name can never be `.` or `..`.
 */
export const SKILL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

/** At most this many skills per plugin (each is copied and loaded into every Claude tab). */
export const MAX_SKILLS = 10

/**
 * Plugin CLI command names (`ccc <name> …`, plan: Claude-operable foundation, Task 4). The name is
 * typed on a command line and routed by the CLI as the first argument, so it is a plain lower-case
 * word: no leading dash (an option), no dot or slash. Minimum two characters keeps single-letter
 * flags-by-habit out.
 */
export const CLI_NAME_PATTERN = /^[a-z][a-z0-9-]{1,31}$/

/**
 * The core `ccc` commands, in USAGE order: the first words the CLI routes itself. src/cli/args.ts
 * dispatches through a table typed by this list (a core command missing here, or listed here and
 * not handled there, is a type error), and the manifest check reserves the same names, so the two
 * cannot drift. Shared because main must not import the CLI.
 */
export const CORE_CLI_COMMANDS = ['open', 'hook', 'session', 'overlay', 'sessions', 'notify', 'guide', 'plugin', 'panel', 'help'] as const
export type CoreCliCommand = (typeof CORE_CLI_COMMANDS)[number]

export function isCoreCliCommand(name: string): name is CoreCliCommand {
  return (CORE_CLI_COMMANDS as readonly string[]).includes(name)
}

/**
 * Names the CLI keeps for itself: every core command, plus words reserved so a later core command
 * does not collide with a plugin that took the name first.
 */
export const RESERVED_CLI_NAMES: readonly string[] = [...CORE_CLI_COMMANDS, 'app', 'config', 'version']

/** At most this many CLI commands per plugin. */
export const MAX_CLI_COMMANDS = 10

/**
 * A top-level `ccc` command the plugin brings; the plugin's host implements it with
 * `ctx.cli.register(name, handler)`. `summary` and `usage` feed `ccc help`; `stdin` is opt-in
 * because reading stdin whenever it is not a TTY would hang a `ccc` started with an open but silent
 * pipe (a tool runner's usual setup).
 */
export interface CliContribution {
  name: string
  summary: string
  usage?: string
  stdin?: boolean
  /**
   * With `stdin`: read it only when an argument is exactly `-`, so the subcommands that take no
   * input never wait on an open, silent pipe (a script's inherited stdin: friction from the Inbox
   * rules CLI, whose `list` waited 40 s). A separate key, not `"stdin": "dash"`: apps before
   * 0.10.1 refuse a non-boolean `stdin` but ignore unknown keys here, so a plugin using it still
   * loads there and only reads stdin as before.
   */
  stdinDash?: boolean
}

/**
 * What a panel shows: `html` (the default) is the plugin's own page from `entry`, in a sandboxed
 * iframe; `webview` is a native web view main lays over the panel (a browser: http(s) pages and
 * local files through `cc-preview://`, driven with `ctx.webview`), so it has no `entry`.
 */
export type PanelKind = 'html' | 'webview'

export interface PanelContribution {
  id: string
  title: string
  /** Default `html`. */
  kind?: PanelKind
  /** Plugin-relative path to an icon (svg/png). */
  icon?: string
  /**
   * Plugin-relative path to the panel's html: required for an `html` panel, forbidden for a
   * `webview` one (the schema's conditional below).
   */
  entry?: string
  defaultZone?: ZoneId
  /**
   * Slot types this panel may place above or below its own frame (`ctx.panels.slots`, design-next
   * §2). Another plugin draws each; main refuses a placement of a type not listed here.
   */
  slots?: string[]
}

export interface CommandContribution {
  id: string
  title: string
  /** Default chord, as written for macOS (`Cmd+Shift+J`). */
  key?: string
}

export interface ThemeContribution {
  id: string
  /** Plugin-relative path to a theme JSON file (src/shared/theme.ts format). */
  file: string
}

/**
 * A Claude skill the plugin brings (plan: Claude-operable foundation, Task 3). `dir` holds a
 * SKILL.md; the folder is copied into the app's generated Claude plugin tree and loaded only into
 * the Claude sessions the app starts, for projects that enable the plugin. Its contents are
 * checked in `src/main/plugins/skill-files.ts` (limits, strict front matter).
 */
export interface SkillContribution {
  id: string
  /** Plugin-relative folder holding SKILL.md. */
  dir: string
}

/**
 * Plugin services (plan: plugin services). A service name is a plain lower-case word because it is
 * a key in `serviceProviders` (project record), a Settings label and an error-message fragment;
 * `constructor`-like words match it too, so every map keyed by it is read with `Object.hasOwn`.
 */
export const SERVICE_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/
/** Versions are whole-number majors in this range. */
export const SERVICE_VERSION_MIN = 1
export const SERVICE_VERSION_MAX = 9999
/** At most this many entries in each of `provides` and `uses`. */
export const MAX_SERVICES = 32

/**
 * The plugin can take over a click on a changed file in the Sessions panel (cockpit.sessions' ctx.sessions.openFile; friction round 1,
 * Task 12): main sends it `{ path, tabId }` through `ctx.files.onOpen`. `title` labels the plugin in
 * Settings > Plugins when the project has to pick between several (and the built-in viewer).
 */
export interface OpenFileContribution {
  title: string
}

/** A JSON Schema as plugins write it; compiled and limited in `validate.ts`. */
export type JsonSchema = Record<string, unknown>

/** Where a plugin's html settings page shows (design-next §5.4): its global page, its project page, or both. */
export const SETTINGS_PAGE_SCOPES = ['app', 'project'] as const
export type SettingsPageScope = (typeof SETTINGS_PAGE_SCOPES)[number]

/**
 * `contributes.settings.page`: an html page shown under the plugin's schema form, for what a form
 * cannot hold (a rules editor). It talks only to the plugin's backend (`ctx.settingsPage.onOpen`),
 * so it needs `main`; it has no settings API of its own.
 */
export interface SettingsPageContribution {
  /** Plugin-relative `.html` page, served from the plugin's folder by `cc-plugin://` like a panel's. */
  entry: string
  /** At least one, no duplicates. */
  scopes: SettingsPageScope[]
}

export interface PluginManifest {
  id: string
  name: string
  version: string
  api: number
  /** Plugin-relative path to the host entry; optional so a theme-only plugin is possible. */
  main?: string
  contributes?: {
    panels?: PanelContribution[]
    settings?: { project?: JsonSchema; app?: JsonSchema; page?: SettingsPageContribution }
    commands?: CommandContribution[]
    themes?: ThemeContribution[]
    skills?: SkillContribution[]
    cli?: CliContribution[]
    openFile?: OpenFileContribution
    /** Slots this plugin can draw in other plugins' panels (or the app's chrome), design-next §2. */
    slots?: SlotContribution[]
  }
  /**
   * Named APIs this plugin offers (`provides`) and calls (`uses`), each with a major version. A
   * top-level field, not under `contributes`: it is a dependency between plugins, not something
   * the app shows. Absent means none, so existing plugins are unaffected.
   */
  services?: { provides?: Record<string, number>; uses?: Record<string, number>; collects?: string[] }
  /**
   * What the plugin may see beyond its own window (design-next §4.1), shown on the Plugins page.
   * `sessions: 'all-windows'`: `ctx.sessions.list/onChange({ scope: 'all' })` answer with a summary of
   * every window's Claude tabs (status, tool, title, project); without it those calls throw. Top level,
   * like `services`: an older app tolerates the unknown key and simply never offers the scope.
   */
  access?: { sessions?: 'all-windows' }
}

/** The manifest declares `"access": { "sessions": "all-windows" }` (ctx.sessions scope `all`). */
export function seesAllSessions(manifest: Pick<PluginManifest, 'access'> | undefined): boolean {
  return manifest?.access?.sessions === 'all-windows'
}

const MAX_PATH_LENGTH = 260
const MAX_LIST = 100

const relativePath = { type: 'string', minLength: 1, maxLength: MAX_PATH_LENGTH }
const title = { type: 'string', minLength: 1, maxLength: 100 }
const contributionId = { type: 'string', pattern: CONTRIBUTION_ID_PATTERN.source }
// The settings schemas themselves are checked (meta-schema, limits) in validate.ts; here they only
// have to be objects.
const settingsSchema = { type: 'object' }
const slotType = { type: 'string', pattern: SLOT_TYPE_PATTERN.source }
const slotHeight = { type: 'integer', minimum: SLOT_HEIGHT_MIN, maximum: SLOT_HEIGHT_MAX }
// name -> major version. `propertyNames` (draft-07) pins the key syntax; the cap keeps a hostile
// manifest from making the status computation (run in main per project) large.
const serviceMap = {
  type: 'object',
  maxProperties: MAX_SERVICES,
  propertyNames: { pattern: SERVICE_NAME_PATTERN.source },
  additionalProperties: { type: 'integer', minimum: SERVICE_VERSION_MIN, maximum: SERVICE_VERSION_MAX }
}

/**
 * JSON Schema (draft-07, what ajv's default class speaks) for `plugin.json`. Unknown properties
 * are tolerated so a later minor release can add fields; known ones are strict. Reasons that
 * need more than a schema (api major, duplicates, paths, chords) are checked in validate.ts.
 */
export const MANIFEST_SCHEMA = {
  type: 'object',
  required: ['id', 'name', 'version', 'api'],
  properties: {
    id: { type: 'string', maxLength: PLUGIN_ID_MAX_LENGTH, pattern: PLUGIN_ID_PATTERN.source },
    name: title,
    version: { type: 'string', maxLength: 64, pattern: PLUGIN_VERSION_PATTERN.source },
    api: { type: 'integer' },
    main: relativePath,
    // Strict inside, unlike the top level: a key the app does not know here (`description`, a
    // misspelt `provide`) is a declaration that silently does nothing, and the plugin host reads
    // only these two.
    // `collects`: the names this plugin reads from every provider (`ctx.services.useAll`); each must
    // also be in `uses` (validate.ts). Unknown to apps before 0.9.7, whose strict schema refuses it.
    services: {
      type: 'object',
      additionalProperties: false,
      properties: {
        provides: serviceMap,
        uses: serviceMap,
        collects: { type: 'array', maxItems: MAX_SERVICES, uniqueItems: true, items: { type: 'string', pattern: SERVICE_NAME_PATTERN.source } }
      }
    },
    // Strict inside like `services`: a misspelt key (`session`) or value would be a declaration that
    // silently grants nothing, and the person reads this on the Plugins page.
    access: {
      type: 'object',
      additionalProperties: false,
      properties: { sessions: { enum: ['all-windows'] } }
    },
    contributes: {
      type: 'object',
      properties: {
        panels: {
          type: 'array',
          maxItems: MAX_LIST,
          items: {
            type: 'object',
            required: ['id', 'title'],
            properties: {
              id: contributionId,
              title,
              kind: { enum: ['html', 'webview'] },
              icon: relativePath,
              entry: relativePath,
              defaultZone: { enum: ['left', 'right', 'bottom'] },
              // App slot types are refused in validate.ts, with the reason.
              slots: { type: 'array', maxItems: MAX_PANEL_SLOT_TYPES, uniqueItems: true, items: slotType }
            },
            // A conditional, not `entry` dropped from `required`: an html panel (kind absent or
            // "html") still must name its page. The `if` needs `required: ['kind']`: `properties`
            // alone holds vacuously when `kind` is absent, which would forbid `entry` on every
            // existing manifest. validate.ts repeats both rules with readable messages.
            if: { required: ['kind'], properties: { kind: { const: 'webview' } } },
            then: { not: { required: ['entry'] } },
            else: { required: ['entry'] }
          }
        },
        settings: {
          type: 'object',
          properties: {
            project: settingsSchema,
            app: settingsSchema,
            // The `.html` entry and `main` are checked in validate.ts, with the reason.
            page: {
              type: 'object',
              required: ['entry', 'scopes'],
              additionalProperties: false,
              properties: {
                entry: relativePath,
                scopes: { type: 'array', minItems: 1, maxItems: 2, uniqueItems: true, items: { enum: [...SETTINGS_PAGE_SCOPES] } }
              }
            }
          }
        },
        commands: {
          type: 'array',
          maxItems: MAX_LIST,
          items: {
            type: 'object',
            required: ['id', 'title'],
            properties: { id: contributionId, title, key: { type: 'string', minLength: 1, maxLength: 50 } }
          }
        },
        themes: {
          type: 'array',
          maxItems: MAX_LIST,
          items: {
            type: 'object',
            required: ['id', 'file'],
            properties: { id: contributionId, file: relativePath }
          }
        },
        skills: {
          type: 'array',
          maxItems: MAX_SKILLS,
          items: {
            type: 'object',
            required: ['id', 'dir'],
            properties: { id: { type: 'string', pattern: SKILL_ID_PATTERN.source }, dir: relativePath }
          }
        },
        cli: {
          type: 'array',
          maxItems: MAX_CLI_COMMANDS,
          items: {
            type: 'object',
            required: ['name', 'summary'],
            properties: {
              name: { type: 'string', pattern: CLI_NAME_PATTERN.source },
              summary: { type: 'string', minLength: 1, maxLength: 200 },
              usage: { type: 'string', minLength: 1, maxLength: 500 },
              stdin: { type: 'boolean' },
              stdinDash: { type: 'boolean' }
            }
          }
        },
        // An object, not `true`: the title is what the person reads when picking the plugin that
        // opens files, and a later field (file kinds, say) has room here.
        openFile: { type: 'object', required: ['title'], properties: { title } },
        // Duplicate types, `min > max`, the `.html` entry and `main` are checked in validate.ts.
        slots: {
          type: 'array',
          maxItems: MAX_PROVIDER_SLOTS,
          items: {
            type: 'object',
            required: ['type', 'entry'],
            properties: { type: slotType, entry: relativePath, title, minHeight: slotHeight, maxHeight: slotHeight }
          }
        }
      }
    }
  }
}

/**
 * Syntax-only check of a plugin-relative file reference; returns the reason it is refused, or
 * null. Refuses absolute paths (POSIX, Windows drive and UNC), backslashes (one separator means
 * one parsing), NUL, and any `..` segment. Whether the file exists and where symlinks lead is
 * checked against the real folder in validate.ts.
 */
export function relativePathProblem(p: string): string | null {
  if (p === '') return 'is empty'
  if (p.includes('\0')) return 'contains a NUL byte'
  if (p.includes('\\')) return 'must use "/" separators'
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return 'must be relative to the plugin folder'
  const segments = p.split('/')
  if (segments.includes('..')) return 'must not contain ".." segments'
  if (segments.every((s) => s === '' || s === '.')) return 'does not name a file'
  return null
}
