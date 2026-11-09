// Plugins that ship inside the app (plan: Claude-operable foundation, Task 9). The set is a fixed
// allowlist in code: the installer indexes exactly these folders and nothing else under the
// resources dir, so a stray folder there (or a hand-edited plugins.json) cannot add a plugin.
//
// Pure: the caller passes the root and the environment, so every rule is testable without Electron.
import { join } from 'node:path'
import { isTestRun } from '../test-run'

export interface BundledPluginSpec {
  /** The manifest id the folder must declare (a folder naming another id is refused). */
  id: string
  /** Folder name under the bundled root; bundledPluginSpecs makes it absolute (`<root>/<dir>`). */
  dir: string
  /** On for every project that has not switched it off. */
  enabledByDefault: boolean
}

/** Folder name under the bundled root -> id and default enablement. */
export const BUNDLED_PLUGINS: readonly BundledPluginSpec[] = [
  { id: 'cockpit.browser', dir: 'browser', enabledByDefault: true },
  { id: 'cockpit.reviewer', dir: 'reviewer', enabledByDefault: true },
  // On by default: without micro, Edit shows how to install it instead of failing silently.
  { id: 'cockpit.editor', dir: 'editor', enabledByDefault: true },
  // The project tree (plugins/files/docs/design.md): opens any file through the open-file pick.
  { id: 'cockpit.files', dir: 'files', enabledByDefault: true },
  // The Claude status view (design-next §4.2): this window's sessions panel and the top bar's
  // sessions-strip slot, on the public API like the others.
  { id: 'cockpit.sessions', dir: 'sessions', enabledByDefault: true },
  // Spend and tokens from Claude Code's transcripts, and the rate-limit windows: the Usage panel and
  // the top bar's usage-meter slot (plugins/usage/README.md).
  { id: 'cockpit.usage', dir: 'usage', enabledByDefault: true }
]

/**
 * Where the bundled plugins live: the repo's `plugins/` in dev, `resources/plugins` (electron-builder
 * `extraResources`) in a packaged app. `appPath` is the repo root (main derives it from its own
 * __dirname: `app.getAppPath()` is `out/main` when launched as `electron out/main/index.js`).
 */
export function bundledRoot(isPackaged: boolean, appPath: string, resourcesPath: string): string {
  return isPackaged ? join(resourcesPath, 'plugins') : join(appPath, 'plugins')
}

/**
 * The plugins to index at this start. `CC_COCKPIT_NO_BUNDLED=1` turns them all off, but only in a
 * test run (`CC_COCKPIT_TEST=1` and not packaged): a shipped app never takes a test-only path, so a
 * stray variable in a user's environment cannot remove the built-in plugins.
 */
export function bundledPluginSpecs(
  root: string,
  env: Record<string, string | undefined>,
  isPackaged: boolean
): BundledPluginSpec[] {
  if (isTestRun(env, isPackaged) && env.CC_COCKPIT_NO_BUNDLED === '1') return []
  return BUNDLED_PLUGINS.map((p) => ({ ...p, dir: join(root, p.dir) }))
}
