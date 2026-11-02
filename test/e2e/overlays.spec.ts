// Task 19: the overlay stack. Overlays are opened through the `openOverlay` test hook (the CLI and
// plugins arrive in Tasks 21 / 27); the hook hands back a handle whose result is what the opener
// got: { kind: 'exit', code }, { kind: 'value', value } or { kind: 'dismissed' }.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { OverlayInfo } from '../../src/shared/ipc'
import { expect, test, type Cockpit } from './fixtures'

// Cmd on macOS, Ctrl elsewhere (the default table maps Cmd to Ctrl on Linux).
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

interface Outcome {
  result?: { kind: string; code?: number; value?: unknown }
  error?: string
}

async function open(c: Cockpit, spec: Record<string, unknown>): Promise<number> {
  const handle = await c.hook<number | undefined>('openOverlay', c.projectDir, spec)
  if (handle === undefined) throw new Error('no window for the project')
  return handle
}

async function outcome(c: Cockpit, handle: number): Promise<Outcome> {
  let last: Outcome = {}
  await expect
    .poll(async () => {
      last = (await c.hook<Outcome | undefined>('overlayResult', handle)) ?? {}
      return last.result !== undefined || last.error !== undefined
    })
    .toBe(true)
  return last
}

const stack = (c: Cockpit): Promise<OverlayInfo[]> => c.hook<OverlayInfo[]>('overlays', c.projectDir)

test('terminal overlays resolve with the exit code of their program and close', async ({ cockpit }) => {
  const ok = await open(cockpit, { kind: 'terminal', argv: ['true'], cwd: cockpit.projectDir })
  expect(await outcome(cockpit, ok)).toEqual({ result: { kind: 'exit', code: 0 } })
  const bad = await open(cockpit, { kind: 'terminal', argv: ['false'], cwd: cockpit.projectDir })
  expect(await outcome(cockpit, bad)).toEqual({ result: { kind: 'exit', code: 1 } })
  await expect(cockpit.page.locator('.overlay')).toHaveCount(0)
  expect(await stack(cockpit)).toEqual([])
})

test('Esc does not close a terminal overlay; Cmd+Shift+W and the close button do', async ({
  cockpit
}) => {
  const { page } = cockpit
  // `cat` echoes what it reads, so the terminal shows it is the program that gets the keys.
  const first = await open(cockpit, { kind: 'terminal', argv: ['cat'], cwd: cockpit.projectDir })
  const overlay = page.locator('.overlay[data-kind="terminal"]')
  await expect(overlay).toBeVisible()
  await expect(overlay.getByRole('button', { name: 'Close overlay' })).toBeVisible()
  await expect(overlay.locator('.xterm-helper-textarea')).toBeFocused()

  await page.keyboard.press('Escape')
  await page.keyboard.type('still here')
  await expect(overlay.locator('.xterm-rows')).toContainText('still here')
  expect(await stack(cockpit)).toHaveLength(1)
  expect(await cockpit.hook<Outcome>('overlayResult', first)).toEqual({})

  await page.keyboard.press(`${MOD}+Shift+KeyW`)
  expect(await outcome(cockpit, first)).toEqual({ result: { kind: 'dismissed' } })
  await expect(overlay).toHaveCount(0)

  const second = await open(cockpit, { kind: 'terminal', argv: ['cat'], cwd: cockpit.projectDir })
  await expect(overlay).toBeVisible()
  await overlay.getByRole('button', { name: 'Close overlay' }).click()
  expect(await outcome(cockpit, second)).toEqual({ result: { kind: 'dismissed' } })
  await expect(overlay).toHaveCount(0)
})

test('an overlay covers the tabs: their keys wait, and the tab gets the keyboard back after', async ({
  cockpit
}) => {
  const { page } = cockpit
  await cockpit.newTab('shell')
  await cockpit.waitForTerminalText('FAKE-SHELL ready')
  const handle = await open(cockpit, { kind: 'terminal', argv: ['cat'], cwd: cockpit.projectDir })
  await expect(page.locator('.overlay')).toBeVisible()
  // Cmd+T would open a tab behind the overlay; it is held back while the overlay is up.
  await page.keyboard.press(`${MOD}+KeyT`)
  await page.keyboard.press(`${MOD}+Shift+KeyW`)
  expect(await outcome(cockpit, handle)).toEqual({ result: { kind: 'dismissed' } })
  await expect(page.getByRole('tab')).toHaveCount(1)
  await expect(page.locator('.terminal-view:not([hidden]) .xterm-helper-textarea')).toBeFocused()
})

test('Tab and Shift+Tab never leave an html overlay for the terminal under it', async ({ cockpit }) => {
  const { page } = cockpit
  await cockpit.newTab('shell')
  await cockpit.waitForTerminalText('FAKE-SHELL ready')
  const handle = await open(cockpit, { kind: 'html', html: '<p>asking</p>', title: 'Question' })
  await expect(page.getByRole('dialog', { name: 'Question' })).toBeFocused()
  // Whatever has the focus, when it is under the overlay (the tab strip, the tab bar, the xterm
  // textarea of the shell): a key typed there would reach a terminal the user cannot see.
  const focusUnder = (): Promise<string | null> =>
    page.evaluate<string | null>(`(() => {
      const el = document.activeElement
      if (!el || el === document.body) return null
      return el.closest('.zones, .top-strip') ? el.tagName + '.' + el.className : null
    })()`)
  for (const key of ['Shift+Tab', 'Tab']) {
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press(key)
      expect(await focusUnder()).toBeNull()
    }
    await page.keyboard.type('zqzq')
  }
  await page.keyboard.press(`${MOD}+Shift+KeyW`)
  expect(await outcome(cockpit, handle)).toEqual({ result: { kind: 'dismissed' } })
  // The keyboard is back in the shell, and the first thing it got is what is typed now: the
  // letters typed while the overlay was up never reached it.
  await expect(page.locator('.terminal-view:not([hidden]) .xterm-helper-textarea')).toBeFocused()
  await cockpit.typeLine('echo after-overlay')
  await cockpit.waitForTerminalText('after-overlay')
  expect(await cockpit.terminalText()).not.toContain('zqzq')
})

test.describe('url overlay', () => {
  let server: Server
  let base: string
  test.beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<!doctype html><title>overlay page</title><p>hello from the page</p>')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
  })
  test.afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  test('closes on Esc with dismissed; the page has no bridge into the app', async ({ cockpit }) => {
    const { page, app } = cockpit
    const handle = await open(cockpit, { kind: 'url', url: base })
    await expect(page.locator('.overlay[data-kind="url"]')).toBeVisible()
    // The page loaded in its own WebContents: no bridge (no preload), no Node, and an in-memory
    // session of its own, not the shell's.
    await expect
      .poll(() =>
        app.evaluate(async ({ BrowserWindow, webContents }, url) => {
          const wc = webContents.getAllWebContents().find((w) => w.getURL() === url)
          if (!wc || wc.isLoading()) return null
          return {
            cockpit: (await wc.executeJavaScript('typeof window.cockpit')) as string,
            require: (await wc.executeJavaScript('typeof require')) as string,
            process: (await wc.executeJavaScript('typeof process')) as string,
            text: (await wc.executeJavaScript('document.body.innerText')) as string,
            persistent: wc.session.isPersistent(),
            shellSession: wc.session === BrowserWindow.getAllWindows()[0]?.webContents.session
          }
        }, base)
      )
      .toEqual({
        cockpit: 'undefined',
        require: 'undefined',
        process: 'undefined',
        text: 'hello from the page',
        persistent: false,
        shellSession: false
      })

    await page.keyboard.press('Escape')
    expect(await outcome(cockpit, handle)).toEqual({ result: { kind: 'dismissed' } })
    await expect(page.locator('.overlay')).toHaveCount(0)
    // The view's page is closed with the overlay, not left running unseen.
    await expect
      .poll(() =>
        app.evaluate(({ webContents }, url) =>
          webContents.getAllWebContents().some((w) => w.getURL() === url), base)
      )
      .toBe(false)
  })

  test('Esc typed into the page itself pops it too (main watches the view)', async ({ cockpit }) => {
    const { app } = cockpit
    const handle = await open(cockpit, { kind: 'url', url: base })
    await expect
      .poll(() =>
        app.evaluate(({ webContents }, url) => {
          const wc = webContents.getAllWebContents().find((w) => w.getURL() === url)
          if (!wc || wc.isLoading()) return false
          wc.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
          wc.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
          return true
        }, base)
      )
      .toBe(true)
    expect(await outcome(cockpit, handle)).toEqual({ result: { kind: 'dismissed' } })
  })

  test('a file: url is refused and no overlay appears', async ({ cockpit }) => {
    const handle = await open(cockpit, { kind: 'url', url: 'file:///etc/hosts' })
    expect((await outcome(cockpit, handle)).error).toMatch(/only http and https/)
    expect(await stack(cockpit)).toEqual([])
    await expect(cockpit.page.locator('.overlay')).toHaveCount(0)
  })
})

test('an html overlay runs its script sandboxed and closes with the value it posts', async ({
  cockpit
}) => {
  const html = `<!doctype html><p>asking</p><script>
    window.addEventListener('message', (e) => {
      const port = e.ports[0]
      if (!port) return
      let parentReachable = true
      try { void window.parent.document } catch { parentReachable = false }
      port.postMessage({ type: 'result', value: { answer: 42, origin: String(window.origin), parentReachable } })
    })
  </script>`
  const handle = await open(cockpit, { kind: 'html', html, title: 'Question' })
  expect(await outcome(cockpit, handle)).toEqual({
    result: { kind: 'value', value: { answer: 42, origin: 'null', parentReachable: false } }
  })
  await expect(cockpit.page.locator('.overlay')).toHaveCount(0)
})

test('Esc pops an html overlay and only the top one', async ({ cockpit }) => {
  const { page } = cockpit
  const lower = await open(cockpit, { kind: 'html', html: '<p>lower</p>', title: 'Lower' })
  const upper = await open(cockpit, { kind: 'html', html: '<p>upper</p>', title: 'Upper' })
  await expect(page.locator('.overlay')).toHaveCount(2)
  await page.keyboard.press('Escape')
  expect(await outcome(cockpit, upper)).toEqual({ result: { kind: 'dismissed' } })
  await expect(page.locator('.overlay')).toHaveCount(1)
  await expect(page.getByRole('dialog', { name: 'Lower' })).toBeVisible()
  expect(await cockpit.hook<Outcome>('overlayResult', lower)).toEqual({})
  await page.keyboard.press('Escape')
  expect(await outcome(cockpit, lower)).toEqual({ result: { kind: 'dismissed' } })
})

test('Esc typed inside an html page (its frame has the keyboard) still pops it', async ({
  cockpit
}) => {
  const { page, app } = cockpit
  const handle = await open(cockpit, { kind: 'html', html: '<input aria-label="field">', title: 'Form' })
  const field = page.frameLocator('iframe[title="Form"]').getByRole('textbox', { name: 'field' })
  await field.click()
  await expect(field).toBeFocused()
  // A native key press, routed to the focused frame: the shell page never sees it, main does.
  await app.evaluate(({ BrowserWindow }) => {
    const wc = BrowserWindow.getAllWindows()[0]!.webContents
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  })
  expect(await outcome(cockpit, handle)).toEqual({ result: { kind: 'dismissed' } })
})

test('closing the window dismisses its overlays', async ({ cockpit }) => {
  const { app } = cockpit
  const t = await open(cockpit, { kind: 'terminal', argv: ['cat'], cwd: cockpit.projectDir })
  const h = await open(cockpit, { kind: 'html', html: '<p>x</p>' })
  await expect(cockpit.page.locator('.overlay')).toHaveCount(2)
  // The picker replaces the window; the app (and main's hooks) stay up.
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    win?.close()
  })
  expect(await outcome(cockpit, t)).toEqual({ result: { kind: 'dismissed' } })
  expect(await outcome(cockpit, h)).toEqual({ result: { kind: 'dismissed' } })
})

// The security claims of url and html overlays, checked against a local server that counts what
// reaches it. "Another site" is `localhost` vs `127.0.0.1`: sameSite compares host names only,
// so another port on 127.0.0.1 would count as the same site.
test.describe('overlay security', () => {
  let server: Server
  let base: string
  let other: string
  const hits = new Map<string, number>()
  test.beforeAll(async () => {
    server = createServer((req, res) => {
      const path = req.url ?? '/'
      hits.set(path, (hits.get(path) ?? 0) + 1)
      if (path === '/redirect') {
        res.writeHead(302, { location: `${other}landed` })
        res.end()
      } else if (path === '/download') {
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-disposition': 'attachment; filename="x.bin"'
        })
        res.end('payload')
      } else {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end('<!doctype html><title>page</title><p>security page</p>')
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    base = `http://127.0.0.1:${port}/`
    other = `http://localhost:${port}/`
  })
  test.afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  test.beforeEach(() => hits.clear())

  /** Replace shell.openExternal in main with a recorder: nothing may reach the real browser. */
  async function stubOpenExternal(c: Cockpit): Promise<() => Promise<string[]>> {
    await c.app.evaluate(({ shell }) => {
      const g = globalThis as { __opened?: string[] }
      g.__opened = []
      shell.openExternal = (url: string) => {
        g.__opened!.push(url)
        return Promise.resolve()
      }
    })
    return () => c.app.evaluate(() => (globalThis as { __opened?: string[] }).__opened ?? [])
  }

  /** Run `code` in the url overlay's page once it has loaded `url`; returns its value. */
  async function inView<T>(c: Cockpit, url: string, code: string): Promise<T> {
    let value: T | undefined
    await expect
      .poll(async () => {
        const out = await c.app.evaluate(
          async ({ webContents }, [u, js]) => {
            const wc = webContents.getAllWebContents().find((w) => w.getURL() === u)
            if (!wc || wc.isLoading()) return { ready: false }
            return { ready: true, value: (await wc.executeJavaScript(js!, true)) as unknown }
          },
          [url, code]
        )
        if (out.ready) value = out.value as T
        return out.ready
      })
      .toBe(true)
    return value as T
  }

  const viewUrls = (c: Cockpit): Promise<string[]> =>
    c.app.evaluate(({ webContents }) => webContents.getAllWebContents().map((w) => w.getURL()))

  test('url: another site, window.open and a cross-site redirect go to the browser, never the view', async ({
    cockpit
  }) => {
    const opened = await stubOpenExternal(cockpit)
    const handle = await open(cockpit, { kind: 'url', url: base })

    await inView(cockpit, base, `location.href = ${JSON.stringify(`${other}link`)}; 1`)
    await expect.poll(opened).toContain(`${other}link`)

    await inView(cockpit, base, `window.open(${JSON.stringify(`${other}popup`)}); 1`)
    await expect.poll(opened).toContain(`${other}popup`)

    // Same site first (stays), then the server sends it to another host: it leaves.
    await inView(cockpit, base, `location.href = ${JSON.stringify(`${base}redirect`)}; 1`)
    await expect.poll(opened).toContain(`${other}landed`)

    // None of them loaded in the app: the view still shows the first page, and no request for
    // them reached the server from inside it.
    expect(hits.get('/link') ?? 0).toBe(0)
    expect(hits.get('/popup') ?? 0).toBe(0)
    expect(hits.get('/landed') ?? 0).toBe(0)
    const urls = await viewUrls(cockpit)
    expect(urls).toContain(base)
    expect(urls.filter((u) => u.startsWith(other))).toEqual([])
    expect(await cockpit.hook<Outcome>('overlayResult', handle)).toEqual({})
  })

  test('url: permission requests and downloads are refused', async ({ cockpit }) => {
    await stubOpenExternal(cockpit)
    await open(cockpit, { kind: 'url', url: base })
    expect(await inView<string>(cockpit, base, 'Notification.requestPermission()')).toBe('denied')
    // The check handler too (navigator.permissions.query reads it), and the clipboard: the view's
    // partition grants nothing, not even 'local-fonts' (it is never the app page).
    for (const name of ['geolocation', 'notifications', 'clipboard-read', 'local-fonts']) {
      const state = await inView<string>(cockpit, base, `navigator.permissions.query({ name: '${name}' }).then((s) => s.state)`)
      expect(state, name).toBe('denied')
    }
    expect(
      await inView<string>(cockpit, base, `navigator.clipboard.readText().then(() => 'read', (e) => 'refused: ' + e.name)`)
    ).toMatch(/^refused: /)
    // A device chooser is cancelled, not answered by Chromium: the request rejects.
    expect(
      await inView<string>(cockpit, base, `navigator.hid.requestDevice({ filters: [] }).then((d) => 'got ' + d.length, (e) => 'refused: ' + e.name)`)
    ).toMatch(/^(refused: |got 0)/)

    // A download the page starts: the app's own will-download listener (registered first, when
    // the session was hardened) has already cancelled it by the time this one runs. The item is
    // destroyed right after, so only the event's flag can be read.
    await cockpit.app.evaluate(({ webContents }, u) => {
      const g = globalThis as { __downloads?: boolean[] }
      g.__downloads = []
      const wc = webContents.getAllWebContents().find((w) => w.getURL() === u)!
      wc.session.on('will-download', (event) => {
        g.__downloads!.push(event.defaultPrevented)
      })
    }, base)
    await inView(cockpit, base, `location.href = ${JSON.stringify(`${base}download`)}; 1`)
    await expect
      .poll(() =>
        cockpit.app.evaluate(() => (globalThis as { __downloads?: boolean[] }).__downloads ?? [])
      )
      .toEqual([true])
  })

  test('url: a page whose renderer dies settles as dismissed and the overlay goes', async ({
    cockpit
  }) => {
    const handle = await open(cockpit, { kind: 'url', url: base })
    await inView(cockpit, base, '1')
    await cockpit.app.evaluate(({ webContents }, u) => {
      webContents.getAllWebContents().find((w) => w.getURL() === u)?.forcefullyCrashRenderer()
    }, base)
    expect(await outcome(cockpit, handle)).toEqual({ result: { kind: 'dismissed' } })
    await expect(cockpit.page.locator('.overlay')).toHaveCount(0)
    expect(await stack(cockpit)).toEqual([])
  })

  test('html: the page CSP blocks every network load', async ({ cockpit }) => {
    const html = `<!doctype html><img src="${base}img"><script>
      window.addEventListener('message', (e) => {
        const port = e.ports[0]
        if (!port) return
        fetch(${JSON.stringify(`${base}fetch`)}).then(
          () => port.postMessage({ type: 'result', value: 'fetched' }),
          () => port.postMessage({ type: 'result', value: 'blocked' })
        )
      })
    </script>`
    const handle = await open(cockpit, { kind: 'html', html })
    expect(await outcome(cockpit, handle)).toEqual({ result: { kind: 'value', value: 'blocked' } })
    // Blocked before any request: CORS alone would still have sent it.
    expect(hits.get('/fetch') ?? 0).toBe(0)
    expect(hits.get('/img') ?? 0).toBe(0)
  })

  test('html: the frame cannot navigate itself off cc-overlay:', async ({ cockpit }) => {
    const html = `<!doctype html><p>stay</p><script>
      location.href = ${JSON.stringify(`${base}escape`)}
    </script>`
    await open(cockpit, { kind: 'html', html, title: 'Escape' })
    await expect(cockpit.page.getByRole('dialog', { name: 'Escape' })).toBeVisible()
    // The shell's frame-src refuses the navigation before a request is made. No event marks
    // "refused", so give a real navigation ample time to have reached the server.
    await cockpit.page.waitForTimeout(1500)
    expect(hits.get('/escape') ?? 0).toBe(0)
    const frames = cockpit.page.frames().map((f) => f.url())
    expect(frames.filter((u) => u.startsWith(base))).toEqual([])
  })

  test('html: a refused result (too large) lets the page answer again', async ({ cockpit }) => {
    const html = `<!doctype html><script>
      window.addEventListener('message', (e) => {
        const port = e.ports[0]
        if (!port) return
        port.postMessage({ type: 'result', value: 'x'.repeat(${1024 * 1024 + 10}) })
        setInterval(() => port.postMessage({ type: 'result', value: { retry: true } }), 100)
      })
    </script>`
    const handle = await open(cockpit, { kind: 'html', html })
    expect(await outcome(cockpit, handle)).toEqual({
      result: { kind: 'value', value: { retry: true } }
    })
  })
})
