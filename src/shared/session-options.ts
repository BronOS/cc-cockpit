// The model and effort a plugin may ask for in ctx.sessions.open. One rule for the plugin host
// (fast TypeError) and main (the authority, which checks again), imported by neither the panel SDK
// nor the renderer (src/sdk/panel.ts is a classic script: a module it shares with main becomes a
// chunk loaded with `require`, CLAUDE.md).
//
// Both are closed lists on purpose: the value becomes the argument of `--model` / `--effort`, and an
// open string would let a plugin pass something that starts with `-` (read as a flag) or name a
// model the person never chose. Full model names are left out: an alias follows the person's
// installed Claude, a pinned name goes stale. `fable` is allowed: the person picks the model in
// their own plugin rules (autopilot), so it is their choice, not the plugin's.

export const SESSION_MODELS = ['haiku', 'sonnet', 'opus', 'fable'] as const
export const SESSION_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

export type SessionModel = (typeof SESSION_MODELS)[number]
export type SessionEffort = (typeof SESSION_EFFORTS)[number]

export type SessionOptionsCheck =
  | { ok: true; model?: SessionModel; effort?: SessionEffort }
  | { ok: false; reason: string }

/**
 * Both fields are optional (absent or undefined: the person's default). Anything else, a
 * non-string included, is refused with a reason that names the field.
 */
export function checkSessionOptions(raw: { model?: unknown; effort?: unknown }): SessionOptionsCheck {
  const { model, effort } = raw
  if (model !== undefined && (typeof model !== 'string' || !(SESSION_MODELS as readonly string[]).includes(model))) {
    return { ok: false, reason: `model must be one of ${SESSION_MODELS.join(', ')}` }
  }
  if (effort !== undefined && (typeof effort !== 'string' || !(SESSION_EFFORTS as readonly string[]).includes(effort))) {
    return { ok: false, reason: `effort must be one of ${SESSION_EFFORTS.join(', ')}` }
  }
  return {
    ok: true,
    ...(model !== undefined ? { model: model as SessionModel } : {}),
    ...(effort !== undefined ? { effort: effort as SessionEffort } : {})
  }
}

// Environment variables a plugin may start a Claude tab with (ctx.sessions.open / ctx.rooms.open
// `env`). A closed list, never a pattern: a Claude tab can be told (prompt injection) to run a plugin
// command that opens tabs, so `env` is untrusted, and an open one could redirect the session
// (`ANTHROPIC_BASE_URL`, `HTTPS_PROXY`) or run code (`PATH`, `NODE_OPTIONS`, `LD_PRELOAD`, `BASH_ENV`).
// Each value is a closed list too: a flag variable takes exactly the value that turns it on.
//
// Adding a variable is one entry here: the name, its allowed values and why a plugin may set it. The
// guide (src/cli/guide/api.md) names the list; the module check below refuses a name that would collide
// with a variable the app sets itself (pty-env.ts), so a later entry cannot shadow the tab's token.

export interface SessionEnvRule {
  /** The only values accepted, compared exactly. */
  readonly values: readonly string[]
  /** One line: what it turns on, and why a plugin may ask for it. */
  readonly why: string
}

export const SESSION_ENV: Readonly<Record<string, SessionEnvRule>> = Object.freeze({
  // Claude Code's experimental Code Mode. A session started with it can only be resumed with it on, so
  // the tab keeps it across a restart and a restore (TabManager, restore.ts).
  CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: Object.freeze({ values: Object.freeze(['1']), why: "Claude Code's experimental Code Mode" })
})

/** At most this many variables per open: the list is short, and a cap keeps a hand-edited record small. */
export const MAX_SESSION_ENV = 8

/**
 * Names the app itself sets or strips in a tab's environment (main/env/pty-env.ts: the tab's id,
 * token and socket, PATH with `ccc` first, the terminal type), and prefixes it owns. A list entry
 * must not be one of them: buildPtyEnv also refuses such an extra at spawn, this catches it at load.
 */
const APP_ENV_NAMES = new Set(['APP_TAB_ID', 'APP_TAB_TOKEN', 'CC_COCKPIT_SOCK', 'PATH', 'TERM', 'COLORTERM', 'CLAUDECODE'])
const APP_ENV_PREFIXES = ['CC_COCKPIT_', 'APP_TAB_', 'ELECTRON_']

/** Whether `name` is one the app sets itself (or owns by prefix), so no extra may carry it. */
export function isAppEnvName(name: string): boolean {
  return APP_ENV_NAMES.has(name) || APP_ENV_PREFIXES.some((p) => name.startsWith(p))
}

// Checked once at load: a list entry that collides fails every import (tests included), never silently.
for (const name of Object.keys(SESSION_ENV)) {
  if (!/^[A-Z][A-Z0-9_]*$/.test(name) || isAppEnvName(name)) throw new Error(`SESSION_ENV: ${name} may not be on the list`)
}

/** Whether `name` is on the list (an own key: `constructor`, `__proto__` and the like are not). */
function ruleOf(name: string): SessionEnvRule | undefined {
  return Object.hasOwn(SESSION_ENV, name) ? SESSION_ENV[name] : undefined
}

export type SessionEnvCheck = { ok: true; env?: Record<string, string> } | { ok: false; reason: string }

/**
 * A plugin's `env`, all or nothing: absent (undefined) is none; otherwise a plain object (its
 * prototype Object.prototype or null, so no class instance or array) of at most MAX_SESSION_ENV own
 * data properties, string keys only, each name on SESSION_ENV and each value a string among its
 * values. Only own keys are read (Reflect.ownKeys: an inherited or a `__proto__` key that JSON.parse
 * made own is a name like any other, and not on the list), and never through a getter. The reason
 * names the variable. The answer is a fresh object with a null prototype, safe to spread into an env.
 */
export function checkSessionEnv(raw: unknown): SessionEnvCheck {
  if (raw === undefined) return { ok: true }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, reason: 'env must be an object' }
  const proto: unknown = Object.getPrototypeOf(raw)
  if (proto !== Object.prototype && proto !== null) return { ok: false, reason: 'env must be a plain object' }
  const keys = Reflect.ownKeys(raw)
  if (keys.length > MAX_SESSION_ENV) return { ok: false, reason: `env takes at most ${MAX_SESSION_ENV} variables` }
  const env = Object.create(null) as Record<string, string>
  for (const key of keys) {
    if (typeof key !== 'string') return { ok: false, reason: 'env names must be strings' }
    const rule = ruleOf(key)
    if (rule === undefined) return { ok: false, reason: `env: ${key.slice(0, 64)} is not allowed (allowed: ${allowedNames()})` }
    const desc = Object.getOwnPropertyDescriptor(raw, key)
    const value: unknown = desc !== undefined && 'value' in desc ? desc.value : undefined
    if (typeof value !== 'string' || !rule.values.includes(value)) {
      return { ok: false, reason: `env: ${key} must be ${rule.values.map((v) => JSON.stringify(v)).join(' or ')}` }
    }
    env[key] = value
  }
  return { ok: true, env }
}

/**
 * A saved tab's `env` (the project record is user-writable, and the list may have changed since it
 * was saved), read leniently: every entry that would fail checkSessionEnv is dropped and named in
 * `dropped`, never applied; the rest is kept, so a session started with Code Mode still resumes with
 * it. `env` is absent when nothing is left. A value that is not an object at all drops everything.
 */
export function savedSessionEnv(raw: unknown): { env?: Record<string, string>; dropped: string[] } {
  if (raw === undefined) return { dropped: [] }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { dropped: ['(not an object)'] }
  const proto: unknown = Object.getPrototypeOf(raw)
  if (proto !== Object.prototype && proto !== null) return { dropped: ['(not a plain object)'] }
  const env = Object.create(null) as Record<string, string>
  const dropped: string[] = []
  let kept = 0
  for (const key of Reflect.ownKeys(raw)) {
    const name = typeof key === 'string' ? key : String(key)
    const rule = typeof key === 'string' ? ruleOf(key) : undefined
    const desc = Object.getOwnPropertyDescriptor(raw, key)
    const value: unknown = desc !== undefined && 'value' in desc ? desc.value : undefined
    if (rule === undefined || typeof value !== 'string' || !rule.values.includes(value) || kept >= MAX_SESSION_ENV) {
      dropped.push(name.slice(0, 64))
      continue
    }
    env[name] = value
    kept += 1
  }
  return kept > 0 ? { env, dropped } : { dropped }
}

/** The names on the list, for errors and the guide. */
export function allowedNames(): string {
  return Object.keys(SESSION_ENV).join(', ')
}
