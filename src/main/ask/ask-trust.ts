// D15: the owner's Ask in a folder Claude Code never trusted. `claude -p` shows no "Is this a project you trust?"
// dialog (task 01's gate, hand step) and runs the folder's own `.claude` hooks and settings, so while Claude Code has
// not trusted the project folder the owner's Ask runs with the guest isolation (D12) and the panel says to open a
// Claude tab there once (its dialog records the trust).
//
// Trust is Claude Code's own record: `projects[<folder>].hasTrustDialogAccepted` in its config file,
// `$CLAUDE_CONFIG_DIR/.claude.json` or `$HOME/.claude.json` (from the login env the Ask runs with, the one claude
// reads). Read-only, re-read at every chat start, never cached: the person may trust the folder in a tab between two
// chats. Fail closed: no HOME, a missing, unreadable, oversized or malformed file, an unknown folder or anything but
// `true` is not trusted.
//
// Which records count is never wider than Claude Code's own check (2.1.332, read from its binary: `M7n` / `Oh` /
// `xh`): the folder itself; inside a git repo, the repo's root (Claude Code walks from the cwd up to the root and no
// further, so a trusted folder above the repo does not count; the folders between are left out here, narrower than
// claude: a needless isolated chat, never a wider one); outside a repo, any parent (claude walks to `/`). The home
// folder's record never counts: Claude Code keeps home trust for one session only.
import { lstat, readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

/** A config larger than this is not read (it is a few MB at most in real use; a parse on main must stay short). */
export const MAX_CLAUDE_CONFIG_BYTES = 32 * 1024 * 1024

/** The config file claude reads under this env, or undefined (no usable HOME or CLAUDE_CONFIG_DIR). */
export function claudeConfigPath(env: Record<string, string | undefined>): string | undefined {
  const dir = env.CLAUDE_CONFIG_DIR
  if (typeof dir === 'string' && dir !== '' && isAbsolute(dir)) return join(dir, '.claude.json')
  const home = env.HOME
  if (typeof home === 'string' && home !== '' && isAbsolute(home)) return join(home, '.claude.json')
  return undefined
}

/** The folder and each parent up to the filesystem root. */
function upward(folder: string): string[] {
  const out: string[] = []
  let at = resolve(folder)
  for (;;) {
    out.push(at)
    const up = dirname(at)
    if (up === at) return out
    at = up
  }
}

/** One project record says the trust dialog was accepted (own keys only: `__proto__` and the like are data). */
function accepted(projects: object, dir: string): boolean {
  if (!Object.prototype.hasOwnProperty.call(projects, dir)) return false
  const entry = (projects as Record<string, unknown>)[dir]
  return typeof entry === 'object' && entry !== null && (entry as { hasTrustDialogAccepted?: unknown }).hasTrustDialogAccepted === true
}

/**
 * Whether `projects` trusts the folder: its own record; inside a git repo (`gitRoot`, the folder's or an ancestor
 * holding `.git`) the root's record; outside one any parent's. `home`'s record never counts.
 */
export function trustedIn(config: unknown, folder: string, gitRoot: string | null, home?: string): boolean {
  if (typeof config !== 'object' || config === null) return false
  const projects = (config as { projects?: unknown }).projects
  if (typeof projects !== 'object' || projects === null || Array.isArray(projects)) return false
  const at = resolve(folder)
  const homeDir = home !== undefined ? resolve(home) : undefined
  const counts = (dir: string): boolean => dir !== homeDir && accepted(projects, dir)
  if (counts(at)) return true
  if (gitRoot !== null) return counts(resolve(gitRoot))
  return upward(at).some(counts)
}

/** The nearest of the folder and its parents that holds a `.git` (a folder, a file or a link: any bounds the walk). */
async function gitRootOf(folder: string): Promise<string | null> {
  for (const dir of upward(folder)) {
    try {
      await lstat(join(dir, '.git'))
      return dir
    } catch {
      // none here
    }
  }
  return null
}

/**
 * Whether Claude Code has trusted `folder` (as given, and as its real path: claude keys by the cwd it ran in).
 * Never throws; every failure is false.
 */
export async function folderTrusted(folder: string, env: Record<string, string | undefined>): Promise<boolean> {
  try {
    if (typeof folder !== 'string' || !isAbsolute(folder)) return false
    const file = claudeConfigPath(env)
    if (file === undefined) return false
    const bytes = await readFile(file)
    if (bytes.length > MAX_CLAUDE_CONFIG_BYTES) return false
    const config: unknown = JSON.parse(bytes.toString('utf8'))
    const home = typeof env.HOME === 'string' && isAbsolute(env.HOME) ? env.HOME : undefined
    if (trustedIn(config, folder, await gitRootOf(folder), home)) return true
    const real = await realpath(folder).catch(() => undefined)
    return real !== undefined && real !== resolve(folder) && trustedIn(config, real, await gitRootOf(real), home)
  } catch {
    return false
  }
}
