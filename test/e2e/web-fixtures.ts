// Web access e2e helpers (plan Tasks 29-30): turn the gateway on in a launched app, on loopback
// only, and open the web shell in a plain browser next to the Electron window.
//
// The browser is Electron's own Chromium started from test/fixtures/web-browser/main.cjs (see its
// header for why not Playwright's download): one window, no preload, its own profile in a temp dir,
// so its cookies are a browser's and not the app's. Playwright drives it like any page.
import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { CockpitApi } from '../../src/shared/ipc'
import type { Cockpit } from './fixtures'

const BROWSER_MAIN = resolve(__dirname, '../fixtures/web-browser/main.cjs')

export interface WebAccessOn {
  port: number
  /** `http://127.0.0.1:<port>`: the gateway's origin. */
  origin: string
  /** The access link as the desktop's Settings shows it (`<origin>/#t=<token>`). */
  link: string
  /** The id of the project the cockpit's window has open. */
  projectId: string
}

/**
 * Turns web access on in the cockpit's window (link mode, the default bind 127.0.0.1: a test
 * never listens on a network address) and waits until the gateway listens. A random port in a
 * range nothing else here uses; one that is taken is tried again with another, so a busy port on
 * the machine cannot fail the spec.
 */
export async function enableWebAccess(cockpit: Cockpit): Promise<WebAccessOn> {
  const { page } = cockpit
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = 20000 + Math.floor(Math.random() * 20000)
    await page.evaluate(async (p) => {
      const api = (window as unknown as { cockpit: CockpitApi }).cockpit
      await api.invoke('settings.webAccessSet', { value: { port: p, enabled: true } })
    }, port)
    let state = ''
    await expect
      .poll(async () => {
        state = await page.evaluate(async () => {
          const view = await (window as unknown as { cockpit: CockpitApi }).cockpit.invoke('settings.webAccess')
          return view.gateway.state
        })
        return state === 'listening' || state === 'failed' || state === 'refused'
      })
      .toBe(true)
    if (state === 'failed') continue
    expect(state).toBe('listening')
    const { link, projectId } = await page.evaluate(async () => {
      const api = (window as unknown as { cockpit: CockpitApi }).cockpit
      const reply = await api.invoke('settings.webAccessLink')
      const info = await api.invoke('window.info')
      return { link: reply.ok ? reply.link : '', projectId: info.kind === 'project' ? info.project.id : '' }
    })
    const origin = `http://127.0.0.1:${port}`
    expect(link.startsWith(`${origin}/#t=`)).toBe(true)
    expect(projectId).not.toBe('')
    return { port, origin, link, projectId }
  }
  throw new Error('web access never listened: five random ports were taken')
}

/**
 * The browser's picker lists the open projects; this clicks the one with `projectId` and waits until
 * its web shell shows (the address names the project). `origin` is the gateway's.
 */
export async function openProjectInBrowser(browser: WebBrowser, origin: string, projectId: string): Promise<void> {
  const { page } = browser
  const href = `?project=${encodeURIComponent(projectId)}`
  await page.getByRole('list', { name: 'Open projects' }).locator(`a[href="${href}"]`).click()
  await expect(page).toHaveURL(`${origin}/${href}`)
  await page.locator('.tabs-pane').waitFor()
}

export interface WebBrowser {
  app: ElectronApplication
  /** The browser's one page (the web shell, once the URL loads). */
  page: Page
  /** Text of the web shell's visible terminal, rows joined with newlines (as `Cockpit.terminalText`). */
  terminalText(): Promise<string>
  /** Wait until the web shell's visible terminal shows `text`. */
  waitForTerminalText(text: string | RegExp, timeout?: number): Promise<void>
  /** URLs the page asked to open in a new tab or window, in order (the fixture records and denies them). */
  opened(): Promise<string[]>
  close(): Promise<void>
}

/** Opens `url` in a fresh plain browser (a profile of its own: no cookie, no device yet). */
export async function openBrowser(url: string): Promise<WebBrowser> {
  const profile = mkdtempSync(join(tmpdir(), 'ccc-e2e-browser-'))
  // Nothing of the cockpit's test env: the browser is not the app and must not look like it.
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue
    if (k.startsWith('CC_COCKPIT_') || k.startsWith('APP_TAB_') || k.startsWith('ELECTRON_')) continue
    // The XDG base dirs follow HOME below: a developer's own XDG_CONFIG_HOME / XDG_CACHE_HOME would
    // point Chromium's writes outside the temp profile again. XDG_RUNTIME_DIR stays (the display).
    if (k === 'XDG_CONFIG_HOME' || k === 'XDG_CACHE_HOME' || k === 'XDG_DATA_HOME' || k === 'XDG_STATE_HOME') continue
    env[k] = v
  }
  // userData alone is not every write: Chromium also writes under HOME (~/.pki's NSS database,
  // ~/.cache), so HOME is the temp profile too, as the cockpit fixture's HOME is its temp dir.
  env.HOME = profile
  const app = await electron.launch({ args: [BROWSER_MAIN, profile, url], env })
  let page: Page
  try {
    page = await app.firstWindow()
  } catch (err) {
    await app.close().catch(() => {})
    rmSync(profile, { recursive: true, force: true })
    throw err
  }
  const rows = page.locator('.terminal-view:not([hidden]) .xterm-rows')
  const terminalText = async (): Promise<string> => (await rows.locator('> div').allInnerTexts()).join('\n')
  return {
    app,
    page,
    terminalText,
    waitForTerminalText: async (text, timeout = 10_000) => {
      try {
        await expect
          .poll(
            async () => {
              const shown = await terminalText()
              // Rows glued too: a long line can be soft-wrapped at this view's width.
              const hit = (t: string): boolean => (typeof text === 'string' ? t.includes(text) : text.test(t))
              return hit(shown) || hit(shown.replaceAll('\n', ''))
            },
            { timeout }
          )
          .toBe(true)
      } catch (err) {
        throw new Error(`web terminal never showed ${String(text)}; it shows:\n${await terminalText()}`, { cause: err })
      }
    },
    opened: () => app.evaluate(() => [...((globalThis as { __opened?: string[] }).__opened ?? [])]),
    close: async () => {
      await app.close().catch(() => {})
      rmSync(profile, { recursive: true, force: true })
    }
  }
}
