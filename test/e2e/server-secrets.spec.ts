// Server mode's secrets end to end (design-web.md §9.5; plan 20261111-server-mode Task 13): the
// real server-mode store, with no fake (CC_COCKPIT_FAKE_SECRETS removed from the app's env) and no
// session bus (server-fixtures.ts: a dead DBUS_SESSION_BUS_ADDRESS, a temp XDG_RUNTIME_DIR). The
// keychain cannot work in that environment; the key file `<data>/secret.key` is what keeps the
// password's hash, so a password set from the server shell must survive a restart and sign a
// browser in after it. Also the plan-time check of `shell.trashItem` with no session bus.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import type { WebCliStatus } from '../../src/shared/web-access'
import { ccc, expectMainAlive, launchServer, type Server } from './server-fixtures'
import { openBrowser, openProjectInBrowser, type WebBrowser } from './web-fixtures'

test.skip(process.platform !== 'linux', 'server mode runs on Linux only')

const PASSWORD = 'correct horse battery staple'

let server: Server | undefined

test.afterEach(async () => {
  await server?.close()
  server = undefined
})

/** Every file under `dir` (the Electron profile is in the data dir too: small files only) that holds `text`. */
function filesHolding(dir: string, text: string): string[] {
  const hits: string[] = []
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const path = join(d, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile() && statSync(path).size < 4_000_000 && readFileSync(path).includes(text)) hits.push(path)
    }
  }
  walk(dir)
  return hits
}

async function status(s: Server): Promise<WebCliStatus> {
  const res = await ccc(s, ['web', 'status', '--json'])
  expect(res.code, res.stderr).toBe(0)
  return JSON.parse(res.stdout) as WebCliStatus
}

/** The sign-in page of a password-mode server: type the password and wait for the picker. */
async function signInWithPassword(browser: WebBrowser, password: string): Promise<void> {
  const { page } = browser
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('list', { name: 'Open projects' }).getByRole('link')).toHaveCount(1, { timeout: 30_000 })
}

test('server secrets: a password set from the shell is kept in the key file, survives a restart and signs a browser in', async () => {
  test.setTimeout(150_000)
  server = await launchServer({ mode: 'link', fakeSecrets: false })
  const { origin, port } = server
  const keyFile = join(server.cockpit.dataDir, 'secret.key')

  // The store of this run is the key file, with nothing wrong with it.
  const before = await status(server)
  expect(before.secrets).toMatchObject({ store: 'keyfile', unavailable: null, otherMode: 0, replaced: 0 })

  // The password comes on stdin (never argv), the mode is the person's second step.
  const set = await ccc(server, ['web', 'password'], `${PASSWORD}\n`)
  expect(set.code, set.stderr).toBe(0)
  expect(set.stdout + set.stderr).not.toContain(PASSWORD)
  const mode = await ccc(server, ['web', 'mode', 'password'])
  expect(mode.code, mode.stderr).toBe(0)

  // The key file exists, mode 0600, 32 bytes of key; the password is nowhere in the data dir in the clear.
  expect(existsSync(keyFile)).toBe(true)
  expect(statSync(keyFile).mode & 0o777).toBe(0o600)
  expect(statSync(keyFile).size).toBe(32)
  expect(filesHolding(server.cockpit.dataDir, PASSWORD)).toEqual([])
  expect((await status(server)).password).toBe('set')

  // A wrong password is refused; the right one signs a browser in.
  const wrong = await fetch(`${origin}/auth/password`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'wrong horse' })
  })
  expect(wrong.status).toBe(401)
  await wrong.body?.cancel()
  const first = await openBrowser(`${origin}/`)
  try {
    await signInWithPassword(first, PASSWORD)
    await openProjectInBrowser(first, origin, server.projectId)
  } finally {
    await first.close()
  }
  const keyBytes = readFileSync(keyFile)

  // Restart on the same data dir: the key file is read again (not replaced), the hash decrypts, and
  // a browser that never signed in gets in with the same password.
  const root = server.cockpit.root
  const exited = new Promise<void>((resolve) => server!.cockpit.app.process().once('exit', () => resolve()))
  expect((await ccc(server, ['web', 'stop'])).code).toBe(0)
  await exited
  await server.close({ keepFiles: true })
  server = await launchServer({ mode: 'link', root, port, fakeSecrets: false })
  expect(readFileSync(keyFile).equals(keyBytes)).toBe(true)
  expect(statSync(keyFile).mode & 0o777).toBe(0o600)
  const after = await status(server)
  expect(after.secrets).toMatchObject({ store: 'keyfile', unavailable: null, otherMode: 0, replaced: 0 })
  expect(after.mode).toBe('password')
  expect(after.password).toBe('set')
  const second = await openBrowser(`${origin}/`)
  try {
    await signInWithPassword(second, PASSWORD)
  } finally {
    await second.close()
  }
  await expectMainAlive(server)
})

test('server secrets: shell.trashItem with no session bus returns or fails cleanly, main survives', async () => {
  test.setTimeout(90_000)
  server = await launchServer({ fakeSecrets: false })
  const file = join(server.cockpit.projectDir, 'to-trash.txt')
  writeFileSync(file, 'x')
  expect(existsSync(file)).toBe(true)
  // Through the real `shell` (no recorder in this launch), with a bound of its own: a hang is a failure.
  const outcome = await server.cockpit.app.evaluate(async ({ shell }, f) => {
    const timeout = new Promise<string>((resolve) => setTimeout(() => resolve('hung'), 30_000))
    const call = shell.trashItem(f).then(
      () => 'trashed',
      (err: unknown) => `failed: ${err instanceof Error ? err.message : String(err)}`
    )
    return Promise.race([call, timeout])
  }, file)
  // What this machine does is recorded in the plan (Task 13); the spec accepts either clean end.
  console.log(`shell.trashItem with no session bus: ${outcome}`)
  expect(outcome).not.toBe('hung')
  if (outcome === 'trashed') expect(existsSync(file)).toBe(false)
  else expect(outcome.startsWith('failed:')).toBe(true)
  await expectMainAlive(server)
})
