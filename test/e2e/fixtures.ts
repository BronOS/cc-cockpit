// E2E harness: launches the BUILT app (out/, which `npm run test:e2e` builds first) with
// everything that could touch the developer's machine redirected into temp dirs.
//
//   CC_COCKPIT_DATA_DIR  fresh temp dir: app data, the Electron profile, the single-instance lock
//   HOME                 fresh temp dir: nothing reads ~/.claude or the real shell rc files
//   SHELL                test/fixtures/bin/fake-shell: no rc files, so the login-env capture
//                        cannot put a real `claude` ahead of the fake one on PATH
//   FAKE_CLAUDE_LOG / FAKE_CLAUDE_PASTE_LOG  where the fake `claude` records its argv and pastes
//   PATH                 test/fixtures/bin first (the fake `claude`), then node's own directory
//                        (the fake is a Node script), then the inherited PATH
//   CC_COCKPIT_FAKE_SECRETS=1  secrets use the marked fake secret store, not the keychain (honored
//                        only with CC_COCKPIT_TEST=1, src/main/secrets/secret-store.ts)
//   CC_COCKPIT_TEST=1    main installs the hooks of src/main/test-hooks.ts
//   CC_COCKPIT_MARKETPLACE_URLS=''  no marketplace index (the default index is not fetched either), so no spec reaches the network
//   CC_COCKPIT_NO_BUNDLED=1  no bundled plugins (browser specs opt out through LaunchOptions.env)
//
// A variable set to undefined in LaunchOptions.env is removed from the app's env, inherited or not
// (Playwright drops undefined values): server-fixtures.ts removes DISPLAY and WAYLAND_DISPLAY that way.
//
// A fresh data dir starts with `app.json` › `claudeTabOnOpen: false` (LaunchOptions.claudeTabOnOpen):
// the app's default opens a Claude tab in a project that opens empty, and most specs build their
// tabs from an empty window and count them or the fake's runs. Likewise `confirmTabClose: false`
// (LaunchOptions.confirmTabClose): the app's default asks before a running tab closes, and specs
// close running tabs by click or Cmd+W as a step, not to test the question. And `zoneAutoHide: false`
// (LaunchOptions.zoneAutoHide): the app's default hides a side zone when the terminal would get
// narrower than 720 px, which the default window does with both side zones open, and the zone and
// panel specs open both to test something else.
import { _electron as electron, test as base, expect, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'

const REPO = resolve(__dirname, '../..')
const FIXTURE_BIN = join(REPO, 'test/fixtures/bin')

export interface Cockpit {
  app: ElectronApplication
  /** The project window. */
  page: Page
  dataDir: string
  /** The temp dir that holds data/, home/ and project/ (pass it as `LaunchOptions.root` to relaunch). */
  root: string
  /** The real (symlinks resolved) path of the project folder the window was opened on. */
  projectDir: string
  /** Every argv the fake `claude` was started with, oldest first (from $FAKE_CLAUDE_LOG). */
  claudeRuns(): string[][]
  /** Every bracketed paste the fake `claude` received, verbatim, oldest first ($FAKE_CLAUDE_PASTE_LOG). */
  pastes(): string[]
  /** Text of the visible terminal (the active tab), rows joined with newlines. */
  terminalText(): Promise<string>
  /** Wait until the visible terminal shows `text`; the failure message includes what it shows. */
  waitForTerminalText(text: string | RegExp, timeout?: number): Promise<void>
  /** Click the active terminal and type `text` followed by Enter. */
  typeLine(text: string): Promise<void>
  /** [+] then Claude / Shell. */
  newTab(kind: 'claude' | 'shell'): Promise<void>
  /** Call a hook of src/main/test-hooks.ts inside main. */
  hook<T = unknown>(name: string, ...args: unknown[]): Promise<T>
}

export interface LaunchOptions {
  /** Extra env for the app (and so for the tabs it starts), e.g. FAKE_CLAUDE_EXIT. Undefined unsets a default above. */
  env?: Record<string, string | undefined>
  /**
   * Relaunch over the data, home and project folders of an earlier run (`Cockpit.root`) instead of
   * making fresh ones: the restore tests quit the app and start it again. Close the earlier run
   * with `keepFiles` or the folders are gone.
   */
  root?: string
  /** Name the project folder on the command line. Default true; false = a plain start, restoring only. */
  folderArg?: boolean
  /** What the first window must be: the project shell (default) or the project picker. */
  ready?: 'project' | 'picker'
  /**
   * The app setting "Open a Claude tab when a project opens with no tabs" for a fresh data dir.
   * Default false (see the header); true leaves app.json alone, so the app's own default applies.
   * Ignored on a relaunch (`root`): that run's app.json is kept as it is.
   */
  claudeTabOnOpen?: boolean
  /**
   * The app setting "Ask before closing a tab that is still running" for a fresh data dir. Default
   * false (see the header); true leaves the app's own default (on). Ignored on a relaunch (`root`).
   */
  confirmTabClose?: boolean
  /**
   * The app setting "Auto-hide side panels when the terminal gets narrow" for a fresh data dir.
   * Default false (see the header); true leaves the app's own default (on). Ignored on a relaunch (`root`).
   */
  zoneAutoHide?: boolean
  /**
   * Extra command-line arguments for the app, before the project folder (server mode's switches,
   * server-fixtures.ts). Every one is a dash-prefixed word, which projectPathFromArgv skips.
   */
  args?: string[]
  /**
   * More `app.json` fields for a fresh data dir, merged over the ones above (server mode's
   * pre-written web access). Ignored on a relaunch (`root`).
   */
  settings?: Record<string, unknown>
}

export async function launchCockpit(
  options: LaunchOptions = {}
): Promise<{ cockpit: Cockpit; close(options?: { keepFiles?: boolean }): Promise<void> }> {
  const root = options.root ?? mkdtempSync(join(tmpdir(), 'ccc-e2e-'))
  const dataDir = join(root, 'data')
  const homeDir = join(root, 'home')
  const projectDir = join(root, 'project')
  if (!options.root) {
    for (const dir of [dataDir, homeDir, projectDir]) mkdirSync(dir)
    // JsonFile shallow-merges the registry's defaults into a partial app.json, so these fields and
    // the schemaVersion (without which the file is quarantined as unsupported) are enough.
    const settings: Record<string, unknown> = { schemaVersion: 1 }
    if (options.claudeTabOnOpen !== true) settings.claudeTabOnOpen = false
    if (options.confirmTabClose !== true) settings.confirmTabClose = false
    if (options.zoneAutoHide !== true) settings.zoneAutoHide = false
    Object.assign(settings, options.settings)
    if (Object.keys(settings).length > 1) writeFileSync(join(dataDir, 'app.json'), JSON.stringify(settings))
  }
  // mkdtemp under /var/folders is a symlink to /private/var on macOS; the app resolves real paths.
  // (A relaunch whose project folder was deleted has nothing to resolve: the path is kept as is.)
  const realProject = existsSync(projectDir) ? realpathSync(projectDir) : join(realpathSync(root), 'project')
  const claudeLog = join(root, 'claude.log')
  const pasteLog = join(root, 'paste.log')

  // The app must not inherit variables that change what Electron or Claude is: running the suite
  // from inside a Claude session (CLAUDECODE) or from an Electron-as-node script would otherwise leak in.
  const inherited: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue
    if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_') || k.startsWith('ELECTRON_')) continue
    // Running the suite from a cockpit tab (dogfood) would otherwise aim the e2e app and its fake
    // claude tabs at the REAL app's socket and the real Claude config.
    if (k.startsWith('CC_COCKPIT_') || k.startsWith('APP_TAB_') || k === 'CLAUDE_CONFIG_DIR') continue
    inherited[k] = v
  }
  const app = await electron.launch({
    // argv[1] is the app path, so the project folder is the THIRD entry (projectPathFromArgv).
    args: [join(REPO, 'out/main/index.js'), ...(options.args ?? []), ...(options.folderArg === false ? [] : [realProject])],
    cwd: REPO,
    env: {
      ...inherited,
      CC_COCKPIT_DATA_DIR: dataDir,
      CC_COCKPIT_FAKE_SECRETS: '1',
      CC_COCKPIT_TEST: '1',
      // Bundled plugins (the browser) off by default: they would add a panel, a zone entry and a
      // host to every window and shift the counts of the panel, zone and layout specs. A spec that
      // wants them passes `env: { CC_COCKPIT_NO_BUNDLED: '' }`.
      CC_COCKPIT_NO_BUNDLED: '1',
      // No marketplace index: the app would otherwise fetch the official one at start.
      CC_COCKPIT_MARKETPLACE_URLS: '',
      // The fake shell is typed into at once; the real 1 s minimum life would keep its banner.
      CC_COCKPIT_SHELL_MIN_LIFE_MS: '0',
      HOME: homeDir,
      SHELL: join(FIXTURE_BIN, 'fake-shell'),
      PATH: [FIXTURE_BIN, dirname(process.execPath), inherited.PATH ?? ''].join(delimiter),
      FAKE_CLAUDE_LOG: claudeLog,
      FAKE_CLAUDE_PASTE_LOG: pasteLog,
      ...options.env
    }
  })
  let page: Page
  try {
    page = await app.firstWindow()
    // The tab bar is the project shell; the picker would mean the folder was not taken from argv.
    await page.locator(options.ready === 'picker' ? '.picker' : '.tabs-pane').waitFor()
    await expect
      .poll(() => app.evaluate(() => typeof (globalThis as Record<string, unknown>).__ccTest))
      .toBe('object')
  } catch (err) {
    // The fixture's try/finally starts only after we return, so clean up here.
    await app.close().catch(() => {})
    rmSync(root, { recursive: true, force: true })
    throw err
  }

  const visibleTerminal = page.locator('.terminal-view:not([hidden]) .xterm-rows')
  const terminalText = async (): Promise<string> => {
    const rows = await visibleTerminal.locator('> div').allInnerTexts()
    return rows.join('\n')
  }
  // The DOM does not say which rows are soft-wrapped, so a long string (a temp path) can be split
  // across rows. Also try the rows glued together so a match does not depend on the window width.
  const terminalTextUnwrapped = async (): Promise<string> => (await terminalText()).replaceAll('\n', '')

  const cockpit: Cockpit = {
    app,
    page,
    dataDir,
    root,
    projectDir: realProject,
    claudeRuns: () => {
      let text: string
      try {
        text = readFileSync(claudeLog, 'utf8')
      } catch {
        return [] // the fake has not run yet
      }
      return text
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[])
    },
    pastes: () => {
      let text: string
      try {
        text = readFileSync(pasteLog, 'utf8')
      } catch {
        return [] // nothing pasted yet
      }
      return text
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string)
    },
    terminalText,
    waitForTerminalText: async (text, timeout = 10_000) => {
      try {
        await expect
          .poll(
            async () => {
              const [rows, glued] = [await terminalText(), await terminalTextUnwrapped()]
              const hit = (t: string): boolean => (typeof text === 'string' ? t.includes(text) : text.test(t))
              return hit(rows) || hit(glued)
            },
            { timeout }
          )
          .toBe(true)
      } catch (err) {
        throw new Error(`terminal never showed ${String(text)}; it shows:\n${await terminalText()}`, {
          cause: err
        })
      }
    },
    typeLine: async (text) => {
      await page.locator('.terminal-view:not([hidden]) .xterm').click()
      await page.keyboard.type(text)
      await page.keyboard.press('Enter')
    },
    newTab: async (kind) => {
      await page.getByRole('button', { name: 'New tab' }).click()
      await page.getByRole('menuitem', { name: kind === 'claude' ? 'Claude' : 'Shell' }).click()
    },
    hook: <T>(name: string, ...args: unknown[]): Promise<T> =>
      app.evaluate(
        (_, { name, args }) => {
          const hooks = (globalThis as unknown as Record<string, Record<string, (...a: unknown[]) => unknown>>)
            .__ccTest
          const hook = hooks?.[name]
          if (!hook) throw new Error(`no test hook ${name}`)
          return hook(...args)
        },
        { name, args }
      ) as Promise<T>
  }

  return {
    cockpit,
    close: async ({ keepFiles = false } = {}) => {
      // Closing the app kills the tabs' PTYs; only then is it safe to remove their cwd.
      await app.close().catch(() => {})
      if (!keepFiles) rmSync(root, { recursive: true, force: true })
    }
  }
}

/** `test` with a `cockpit` fixture: a fresh app, data dir and project folder per test. */
export const test = base.extend<{ cockpit: Cockpit }>({
  // eslint-disable-next-line no-empty-pattern
  cockpit: async ({}, use) => {
    const { cockpit, close } = await launchCockpit()
    try {
      await use(cockpit)
    } finally {
      await close()
    }
  }
})

export { expect }
