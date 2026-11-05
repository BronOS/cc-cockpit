import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { createServer as createSocketServer, type AddressInfo } from 'node:net'
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, launchCockpit, test, type Cockpit } from './fixtures'

interface Ran {
  status: number | null
  out: string
  err: string
}

/**
 * Run the generated `<data>/bin/ccc` the way a user's terminal would: not in a tab (no token, no
 * socket variable), so the CLI finds the app by itself from the data dir the wrapper sets. The
 * suite's own CC_COCKPIT_* / APP_TAB_* variables (a dogfood run from a cockpit tab) are dropped.
 */
function ccc(c: Cockpit, args: string[], timeoutMs = 20_000): Promise<Ran> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || k.startsWith('CC_COCKPIT_') || k.startsWith('APP_TAB_') || k.startsWith('ELECTRON_')) continue
    env[k] = v
  }
  env.HOME = c.dataDir
  return new Promise((resolve, reject) => {
    const child = spawn(join(c.dataDir, 'bin', 'ccc'), args, { env })
    let out = ''
    let err = ''
    child.stdout.on('data', (d: Buffer) => (out += d.toString()))
    child.stderr.on('data', (d: Buffer) => (err += d.toString()))
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`ccc ${args.join(' ')} did not finish in ${timeoutMs} ms; out=${out} err=${err}`))
    }, timeoutMs)
    child.on('close', (status) => {
      clearTimeout(timer)
      resolve({ status, out, err })
    })
  })
}

interface Listing {
  tabId: string
  project: string
  projectPath: string
  status: string
  notes: string[]
  steps?: { done: number; total: number }
}

test('main writes hooks.json and a working bin/ccc before any Claude tab, and the CLI exits 0', async () => {
  const { cockpit, close } = await launchCockpit()
  try {
    const wrapper = join(cockpit.dataDir, 'bin', 'ccc')
    expect(statSync(wrapper).mode & 0o777).toBe(0o755)

    const hooks = JSON.parse(readFileSync(join(cockpit.dataDir, 'hooks.json'), 'utf8')) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>
    }
    expect(Object.keys(hooks.hooks)).toContain('PreToolUse')
    expect(hooks.hooks.PreToolUse?.[0]?.hooks[0]?.command).toBe(`'${wrapper}' hook PreToolUse`)

    // Run the generated wrapper itself, which starts the built Electron binary as plain Node on
    // out/cli/index.js: a CLI bundle that pulled in `electron` would fail here.
    const sample = JSON.stringify({ session_id: 's', tool_name: 'Bash', tool_input: { command: 'ls' } })
    const base = { PATH: process.env.PATH ?? '', HOME: cockpit.dataDir }

    // No app reachable: a tab token with no socket variable, then a socket path nobody owns.
    for (const extra of [{}, { CC_COCKPIT_SOCK: join(cockpit.dataDir, 'nobody.sock') }]) {
      const quiet = spawnSync(wrapper, ['hook', 'PreToolUse'], {
        input: sample,
        encoding: 'utf8',
        env: { ...base, APP_TAB_TOKEN: 'a'.repeat(64), ...extra }
      })
      expect({ status: quiet.status, out: quiet.stdout, err: quiet.stderr }).toEqual({
        status: 0,
        out: '',
        err: ''
      })
    }

    // The running app: main answers the unknown token with an error reply, which the hook never reads.
    const info = await cockpit.hook<{ path: string; listening: boolean }>('socket')
    const live = spawnSync(wrapper, ['hook', 'PreToolUse'], {
      input: sample,
      encoding: 'utf8',
      env: { ...base, APP_TAB_TOKEN: 'a'.repeat(64), CC_COCKPIT_SOCK: info.path }
    })
    expect({ status: live.status, out: live.stdout, err: live.stderr }).toEqual({ status: 0, out: '', err: '' })
  } finally {
    await close()
  }
})

test('inside a Claude tab, session note and steps reach the session; sessions --json lists the tab', async ({
  cockpit
}) => {
  // What the session registry holds for the tab (what ctx.sessions, and so the Sessions panel of
  // the bundled cockpit.sessions plugin, show: sessions-panel.spec.ts).
  const session = async (): Promise<{ notes?: string[]; steps?: { done: number; total: number } } | undefined> =>
    (await cockpit.hook<Array<{ notes?: string[]; steps?: { done: number; total: number } }>>('sessions', cockpit.projectDir))[0]

  await cockpit.newTab('claude')
  await cockpit.waitForTerminalText('FAKE-CLAUDE banner')
  // The fake runs `ccc` from PATH (main prepends <data>/bin) with the tab's token and socket.
  await cockpit.typeLine('/ccc session note hi there')
  await cockpit.waitForTerminalText('FAKE-CLAUDE ccc exit=0')
  await cockpit.typeLine('/ccc session steps 3/5')
  await expect.poll(async () => (await session())?.notes).toEqual(['hi there'])
  await expect.poll(async () => (await session())?.steps).toEqual({ done: 3, total: 5 })

  // done > total fails in the CLI itself (usage, exit 2) before the app is asked.
  await cockpit.typeLine('/ccc session steps 9/5')
  await cockpit.waitForTerminalText('FAKE-CLAUDE ccc exit=2')
  expect((await session())?.steps).toEqual({ done: 3, total: 5 })

  // From outside any tab: the Claude tabs of every window.
  const listed = await ccc(cockpit, ['sessions', '--json'])
  expect(listed).toMatchObject({ status: 0, err: '' })
  const list = JSON.parse(listed.out) as Listing[]
  expect(list).toHaveLength(1)
  expect(list[0]).toMatchObject({
    projectPath: cockpit.projectDir,
    notes: ['hi there'],
    steps: { done: 3, total: 5 }
  })
  expect(list[0]?.status).toMatch(/^(starting|idle)$/)
  // The plain form: project, status, tool, tab id, tab-separated.
  const plain = await ccc(cockpit, ['sessions'])
  expect(plain.out.split('\t')).toHaveLength(4)
  expect(plain.out).toContain(list[0]?.tabId)
})

test('session note from outside a tab is refused by main (it needs a tab token)', async ({ cockpit }) => {
  const outside = await ccc(cockpit, ['session', 'note', 'x'])
  expect(outside).toMatchObject({ status: 1, out: '' })
  expect(outside.err).toMatch(/tab token/)
})

test('overlay --terminal prints the exit code; --html prints the value the page posts; errors are clear', async ({
  cockpit
}) => {
  const zero = await ccc(cockpit, ['overlay', '--project', cockpit.projectDir, '--terminal', '--', 'true'])
  expect(zero).toEqual({ status: 0, out: '{"kind":"exit","code":0}\n', err: '' })
  const one = await ccc(cockpit, ['overlay', '--project', cockpit.projectDir, '--terminal', '--', 'false'])
  expect(one).toEqual({ status: 0, out: '{"kind":"exit","code":1}\n', err: '' })

  // A one-shot page: served from the file's content under the overlay's own scheme and CSP; it
  // answers through the MessagePort the shell hands over.
  const dir = mkdtempSync(join(tmpdir(), 'ccc-e2e-html-'))
  try {
    const file = join(dir, 'ask.html')
    writeFileSync(
      file,
      `<!doctype html><title>ask</title><script>
        addEventListener('message', (e) => {
          if (e.data && e.data.type === 'cc-overlay.port' && e.ports[0]) {
            e.ports[0].postMessage({ type: 'result', value: { answer: 42 } })
          }
        })
      </script>`
    )
    const html = await ccc(cockpit, ['overlay', '--project', cockpit.projectDir, '--html', file])
    expect(html).toEqual({ status: 0, out: '{"kind":"value","value":{"answer":42}}\n', err: '' })
    // Output far past a pipe buffer (64 KiB on macOS; process.exit used to cut it at 512 bytes)
    // must arrive whole and parse.
    const big = join(dir, 'big.html')
    writeFileSync(
      big,
      `<!doctype html><title>big</title><script>
        addEventListener('message', (e) => {
          if (e.data && e.data.type === 'cc-overlay.port' && e.ports[0]) {
            e.ports[0].postMessage({ type: 'result', value: 'x'.repeat(200000) })
          }
        })
      </script>`
    )
    const large = await ccc(cockpit, ['overlay', '--project', cockpit.projectDir, '--html', big])
    expect(large.status).toBe(0)
    expect(JSON.parse(large.out)).toEqual({ kind: 'value', value: 'x'.repeat(200000) })
    const gone = await ccc(cockpit, ['overlay', '--project', cockpit.projectDir, '--html', join(dir, 'nope.html')])
    expect(gone).toMatchObject({ status: 1, out: '' })
    expect(gone.err).toMatch(/cannot read that file/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  // The window must be open; main never opens a project for an overlay.
  const other = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-e2e-closed-')))
  try {
    const closed = await ccc(cockpit, ['overlay', '--project', other, '--terminal', '--', 'true'])
    expect(closed).toMatchObject({ status: 1, out: '' })
    expect(closed.err).toMatch(/not open/)
  } finally {
    rmSync(other, { recursive: true, force: true })
  }
  // Outside a tab with no --project, and a typo: usage errors (2) with the reason.
  expect(await ccc(cockpit, ['overlay', '--terminal', '--', 'true'])).toMatchObject({ status: 2, out: '' })
  const typo = await ccc(cockpit, ['Frobnicate'])
  expect(typo.status).toBe(2)
  expect(typo.err).toContain('unknown command: Frobnicate')
  // A word shaped like a plugin command: outside a tab it needs --project (usage, 2); with it,
  // main says no plugin of the project has it (refused, 1).
  const plugin = await ccc(cockpit, ['frobnicate'])
  expect(plugin.status).toBe(2)
  expect(plugin.err).toContain('needs --project')
  const unknown = await ccc(cockpit, ['--project', cockpit.projectDir, 'frobnicate'])
  expect(unknown).toMatchObject({ status: 1, out: '' })
  expect(unknown.err).toContain('unknown command: frobnicate')
  expect(await cockpit.hook<unknown[]>('overlays', cockpit.projectDir)).toEqual([])
})

test('overlay --url waits for the user and prints dismissed on Esc', async ({ cockpit }) => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<!doctype html><title>cli url</title><p>from the cli</p>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
    const waiting = ccc(cockpit, ['overlay', '--project', cockpit.projectDir, '--url', base])
    await expect(cockpit.page.locator('.overlay[data-kind="url"]')).toBeVisible()
    await expect
      .poll(async () => (await cockpit.hook<Array<{ kind: string }>>('overlays', cockpit.projectDir)).map((o) => o.kind))
      .toEqual(['url'])
    await cockpit.page.keyboard.press('Escape')
    expect(await waiting).toEqual({ status: 0, out: '{"kind":"dismissed"}\n', err: '' })
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('a window closed while ccc overlay waits ends it with dismissed and exit 0', async ({ cockpit }) => {
  // A second project window, so closing it leaves the app on the first one.
  const other = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-e2e-wait-')))
  try {
    await cockpit.hook('openProject', other)
    await expect.poll(() => cockpit.app.windows().length).toBe(2)
    const waiting = ccc(cockpit, ['overlay', '--project', other, '--terminal', '--', 'sleep', '30'])
    await expect
      .poll(async () => (await cockpit.hook<Array<{ kind: string }>>('overlays', other)).map((o) => o.kind))
      .toEqual(['terminal'])
    const page = cockpit.app.windows().find((p) => p !== cockpit.page)!
    await page.close()
    expect(await waiting).toEqual({ status: 0, out: '{"kind":"dismissed"}\n', err: '' })
  } finally {
    rmSync(other, { recursive: true, force: true })
  }
})

test('inside a tab the token picks the window: overlay --terminal -- true resolves with code 0', async ({
  cockpit
}) => {
  await cockpit.newTab('claude')
  await cockpit.waitForTerminalText('FAKE-CLAUDE banner')
  await cockpit.typeLine('/ccc overlay --terminal -- true')
  await cockpit.waitForTerminalText(/FAKE-CLAUDE ccc exit=0 out=.*exit.*code.*0/)
})

// Review findings: a plugin command's large stderr was cut at the pipe's 64 KiB when the CLI
// exited (only stdout was flushed first), and `plugin list --project` was refused by main ("needs
// a tab token") before its handler. Both from outside a tab, through pipes, as a script runs ccc.
test('outside a tab: a plugin command prints 200,000 bytes on each stream through a pipe; plugin list --project answers', async ({
  cockpit
}) => {
  await cockpit.hook('linkPlugin', join(__dirname, '..', 'fixtures', 'plugins', 'host-cli'))
  await cockpit.hook('enablePlugin', cockpit.projectDir, 'test.hostcli')
  await expect
    .poll(() => cockpit.hook<{ running: boolean; plugins: Array<{ id: string; state: string }> }>('hostStatus', cockpit.projectDir), {
      timeout: 15_000
    })
    .toMatchObject({ running: true, plugins: [{ id: 'test.hostcli', state: 'active' }] })

  const big = await ccc(cockpit, ['--project', cockpit.projectDir, 'demo', 'big'])
  expect(big.status).toBe(4)
  expect(big.out.length).toBe(200000)
  expect(big.err.length).toBe(200000)
  expect(big.err).toBe('e'.repeat(200000))

  const listed = await ccc(cockpit, ['plugin', 'list', '--project', cockpit.projectDir, '--json'])
  expect(listed).toMatchObject({ status: 0, err: '' })
  expect(JSON.parse(listed.out)).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'test.hostcli', enabled: true })]))
})

test('open opens a folder in a new window and only focuses it on a second call; notify reaches main', async ({
  cockpit
}) => {
  const other = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-e2e-open-')))
  try {
    expect(cockpit.app.windows()).toHaveLength(1)
    expect(await ccc(cockpit, ['open', other])).toEqual({ status: 0, out: '', err: '' })
    await expect.poll(() => cockpit.app.windows().length).toBe(2)
    expect(await ccc(cockpit, ['open', other])).toEqual({ status: 0, out: '', err: '' })
    await expect.poll(() => cockpit.app.windows().length).toBe(2)
    // Not a folder: main refuses.
    const bad = await ccc(cockpit, ['open', join(other, 'no-such-dir')])
    expect(bad).toMatchObject({ status: 1, out: '' })

    expect(await ccc(cockpit, ['notify', 'build', 'finished'])).toEqual({ status: 0, out: '', err: '' })
    expect(await cockpit.hook<string[]>('notifications')).toEqual(['build finished'])
  } finally {
    rmSync(other, { recursive: true, force: true })
  }
})

test('with the app not running every command exits 0 and prints nothing', async () => {
  const { cockpit, close } = await launchCockpit()
  const wrapper = join(cockpit.dataDir, 'bin', 'ccc')
  const dataDir = cockpit.dataDir
  // The wrapper lives in the data dir, which close() removes: keep it until the commands ran.
  await cockpit.app.close().catch(() => {})
  try {
    const env: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: dataDir }
    for (const args of [
      ['open', dataDir],
      ['session', 'note', 'x'],
      ['sessions', '--json'],
      ['notify', 'x'],
      ['overlay', '--project', dataDir, '--terminal', '--', 'true']
    ]) {
      const r = spawnSync(wrapper, args, { env, encoding: 'utf8', timeout: 20_000 })
      expect({ args, status: r.status, out: r.stdout, err: r.stderr }).toEqual({ args, status: 0, out: '', err: '' })
    }
  } finally {
    await close()
  }
})

// The built entry on purpose: the stderr `error` listener is in src/cli/index.ts, which only runs as the
// real process. The version warning fails only after the write returned, while stdin is being awaited.
test('a stderr nobody reads does not stop a plugin command after the version warning', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccc-e2e-stderr-'))
  const sock = join(dir, 's.sock')
  const seen: string[] = []
  const app = createSocketServer((socket) => {
    let buffered = ''
    socket.on('error', () => {})
    socket.on('data', (chunk) => {
      buffered += chunk.toString()
      const lines = buffered.split('\n')
      buffered = lines.pop() ?? ''
      for (const line of lines) {
        const r = JSON.parse(line) as { id: number; cmd: string; args: { stdin?: string } }
        seen.push(r.cmd)
        const result = r.cmd === 'plugin.cli.spec' ? { name: 'demo', usage: 'demo', stdin: true } : { stdout: `ran: ${r.args.stdin}\n`, stderr: 'plugin says\n', code: 3 }
        socket.write(`${JSON.stringify({ id: r.id, ok: true, appVersion: '99.1.2', result })}\n`)
      }
    })
  })
  await new Promise<void>((resolve) => app.listen(sock, resolve))
  try {
    const child = spawn(process.execPath, [join(__dirname, '../../out/cli/index.js'), 'demo'], {
      env: { PATH: process.env.PATH ?? '', HOME: dir, APP_TAB_TOKEN: 'token', CC_COCKPIT_SOCK: sock }
    })
    child.stderr.destroy()
    let out = ''
    child.stdout.on('data', (d: Buffer) => (out += d.toString()))
    const status = new Promise<number | null>((resolve) => child.on('close', resolve))
    // stdin stays open long enough for the failed write to surface while the command waits on it.
    setTimeout(() => child.stdin.end('hello'), 300)
    expect(await status).toBe(3)
    expect(out).toBe('ran: hello\n')
    expect(seen).toEqual(['plugin.cli.spec', 'plugin.cli'])
  } finally {
    app.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
