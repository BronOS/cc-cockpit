// Data dir resolution and every path derived from it (plan: Technical Details > Data dir layout).
//
// Pure Node on purpose: no `electron` import. `src/cli` imports `socketPath()` from here so the CLI
// and main compute the exact same socket path from the same inputs, and unit tests (plain Node)
// load this file. The Electron-specific part (where userData lives, `app.setPath`) stays in
// `src/main/index.ts`, which passes the userData base in as an argument.
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'

/** Env var that moves the whole data dir (tests, dev instances). */
export const DATA_DIR_ENV = 'CC_COCKPIT_DATA_DIR'
/** Env var that overrides the CLI socket path (main sets it for every Claude tab). */
export const SOCK_ENV = 'CC_COCKPIT_SOCK'

/**
 * macOS `sun_path` is 104 bytes including the NUL; Linux's is 108. Test temp dirs
 * (`/var/folders/...`) are long enough to blow through it, and `listen()` then fails with a
 * confusing EINVAL/ENAMETOOLONG. 100 leaves a little slack under the smaller limit.
 */
export const SOCKET_PATH_MAX_BYTES = 100

type Env = Record<string, string | undefined>

/**
 * The data dir: `CC_COCKPIT_DATA_DIR` when set and non-empty, else `base` (Electron's userData,
 * passed in so this stays testable). A relative override is resolved against the cwd, since every
 * later path (and the socket path the CLI recomputes) must be absolute and identical for both sides.
 */
export function resolveDataDir(base: string, env: Env): string {
  const override = env[DATA_DIR_ENV]
  return override ? resolve(override) : base
}

/**
 * Where Electron puts `userData` for the app name `cc-cockpit`, computed without Electron for the
 * CLI (which runs as plain Node and cannot ask `app.getPath`). Only used when neither
 * `CC_COCKPIT_DATA_DIR` nor `CC_COCKPIT_SOCK` is set, i.e. a tokenless call from a terminal that
 * did not come from the app; the generated `bin/ccc` wrapper always sets the data dir.
 */
export function defaultDataDir(platform: string, env: Env, home: string): string {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'cc-cockpit')
  if (platform === 'win32') return join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'cc-cockpit')
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'cc-cockpit')
}

export interface DataPaths {
  dataDir: string
  appJson: string
  projectsDir: string
  pluginsDir: string
  pluginsJson: string
  pluginDataRoot: string
  logsDir: string
  hooksJson: string
  /**
   * The generated Claude Code plugins every Claude tab loads with `--plugin-dir`
   * (claude-plugins/claude-plugins.ts): `core/` today, one folder per skill-bearing plugin later.
   */
  claudePluginsDir: string
  /** Plugin secrets (`ctx.secrets`, secret settings fields), encrypted values only. */
  secretsJson: string
  binDir: string
  cccWrapper: string
  /** The default socket location; use `socketPath()` for the effective one (it may fall back). */
  defaultSocket: string
}

/** Every fixed path in the data dir layout. */
export function dataPaths(dataDir: string): DataPaths {
  return {
    dataDir,
    appJson: join(dataDir, 'app.json'),
    projectsDir: join(dataDir, 'projects'),
    pluginsDir: join(dataDir, 'plugins'),
    pluginsJson: join(dataDir, 'plugins.json'),
    pluginDataRoot: join(dataDir, 'plugin-data'),
    logsDir: join(dataDir, 'logs'),
    hooksJson: join(dataDir, 'hooks.json'),
    claudePluginsDir: join(dataDir, 'claude-plugins'),
    secretsJson: join(dataDir, 'secrets.json'),
    binDir: join(dataDir, 'bin'),
    cccWrapper: join(dataDir, 'bin', 'ccc'),
    defaultSocket: join(dataDir, 'app.sock')
  }
}

/**
 * What a project id looks like (ProjectRegistry refuses every other id). Lower-case hex only, so
 * `APP_DATA_FOLDER` (with its `_`) can never be a project's folder under `plugin-data/`.
 */
export const PROJECT_ID_PATTERN = /^[0-9a-f]{16}$/

/** `projectId` = first 16 hex chars of sha256 of the real (resolved) folder path. */
export function projectId(realPath: string): string {
  return createHash('sha256').update(realPath).digest('hex').slice(0, 16)
}

/** `<data>/projects/<projectId>.json`. */
export function projectFile(dataDir: string, id: string): string {
  return join(dataDir, 'projects', `${id}.json`)
}

/**
 * `<data>/plugins/<id>@<version>/`. The caller must have validated `pluginId` against the manifest
 * id regex (and the version) first: this only joins, it does not sanitize.
 */
export function pluginInstallDir(dataDir: string, pluginId: string, version: string): string {
  return join(dataDir, 'plugins', `${pluginId}@${version}`)
}

/** The file name of a plugin's KV store inside its data dir (ctx.storage) and its app data dir (ctx.appStorage). */
export const STORAGE_FILE_NAME = 'storage.json'

/** `<data>/plugin-data/<projectId>/<pluginId>/` (ctx.dataDir; storage.json lives inside). */
export function pluginDataDir(dataDir: string, id: string, pluginId: string): string {
  return join(dataDir, 'plugin-data', id, pluginId)
}

/**
 * The app-wide folder beside the project folders of `plugin-data/`. Never a project id: those match
 * PROJECT_ID_PATTERN (16 lower-case hex characters), and `_` is not hex.
 */
export const APP_DATA_FOLDER = '_app'

/** `<data>/plugin-data/_app/<pluginId>/` (ctx.appDataDir; main's app storage.json lives inside). */
export function pluginAppDataDir(dataDir: string, pluginId: string): string {
  return join(dataDir, 'plugin-data', APP_DATA_FOLDER, pluginId)
}

/**
 * The fallback socket directory `<tmpdir>/ccc-<uid>/`. Per-uid because `os.tmpdir()` is shared on
 * Linux; the server creates it 0700 and refuses a pre-existing one owned by someone else.
 */
export function fallbackSocketDir(tmpdir: string, uid: number | string): string {
  return join(tmpdir, `ccc-${uid}`)
}

/**
 * The effective socket path: `$CC_COCKPIT_SOCK`, else `<data>/app.sock`. When that exceeds 100
 * bytes, `<tmpdir>/ccc-<uid>/<sha256(dataDir)[0:12]>.sock`, derived from the data dir so main and
 * the CLI agree, and two data dirs (parallel e2e runs) never share a socket.
 *
 * The fallback applies to an over-long `$CC_COCKPIT_SOCK` too: refusing to bind would be worse than
 * a deterministic alternative, and main exports the path it actually uses to its tabs, so a
 * too-long value only arrives from the user's own environment.
 *
 * Byte length, not string length: `sun_path` counts bytes and a home dir may be non-ASCII.
 */
export function socketPath(
  dataDir: string,
  env: Env,
  uid: number | string,
  tmpdir: string
): string {
  const wanted = env[SOCK_ENV] || join(dataDir, 'app.sock')
  if (Buffer.byteLength(wanted) <= SOCKET_PATH_MAX_BYTES) return wanted
  const hash = createHash('sha256').update(dataDir).digest('hex').slice(0, 12)
  return join(fallbackSocketDir(tmpdir, uid), `${hash}.sock`)
}
