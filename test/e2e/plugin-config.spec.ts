// Friction round 1, Task 6: `ccc plugin config` from a terminal outside the app (`--project`). It
// prints a plugin's app, global and project settings (a secret field only as set / not set), and sets
// top-level fields through the Settings form's save: the running plugin hears of it by
// `ctx.onSettingsChange`, a value the schema refuses stores nothing, a secret field is refused.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HostStatus } from '../../src/main/plugins/host-manager'
import { expect, test, type Cockpit } from './fixtures'

const FIXTURE = join(__dirname, '..', 'fixtures', 'plugins', 'host-config')
const ID = 'test.hostconfig'

interface Ran {
  status: number | null
  out: string
  err: string
}

/** The generated `<data>/bin/ccc`, as a user's own terminal runs it (no tab token): see cli.spec.ts. */
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

interface Seen {
  start: { app: Record<string, unknown>; project: Record<string, unknown> }
  changes: Array<{ app: Record<string, unknown>; project: Record<string, unknown> }>
}

test('ccc plugin config prints and sets a plugin\'s settings; the plugin hears of it; secrets and bad values are refused', async ({ cockpit }) => {
  await cockpit.hook('linkPlugin', FIXTURE)
  await cockpit.hook('enablePlugin', cockpit.projectDir, ID)
  await expect
    .poll(() => cockpit.hook<HostStatus>('hostStatus', cockpit.projectDir), { timeout: 15_000 })
    .toMatchObject({ running: true, plugins: [{ id: ID, state: 'active' }] })
  const seenFile = join(cockpit.root, 'home', 'host-config.json')
  await expect.poll(() => existsSync(seenFile), { timeout: 15_000 }).toBe(true)
  const seen = (): Seen => JSON.parse(readFileSync(seenFile, 'utf8')) as Seen
  expect(seen().start).toEqual({ app: { limit: 10 }, project: { board: 'main' } })
  const config = (...args: string[]): Promise<Ran> => ccc(cockpit, ['plugin', 'config', '--project', cockpit.projectDir, ID, ...args])

  // Print: defaults, the secret only as "not set".
  const noOverrides = '# project: no overrides, every field uses the global value\n'
  expect(await config()).toEqual({
    status: 0,
    out: `app limit = 10\napp token = not set\nglobal board = "main"\nproject board = "main"\n${noOverrides}`,
    err: ''
  })
  const json = await config('--json')
  expect(json.status).toBe(0)
  expect(JSON.parse(json.out)).toEqual({
    id: ID,
    app: { fields: ['limit', 'token'], values: { limit: 10 }, secrets: { token: false } },
    global: { fields: ['board'], values: { board: 'main' }, secrets: {} },
    project: { fields: ['board'], values: { board: 'main' }, secrets: {}, overrides: [] }
  })

  // Set an app field: stored in app.json, and the running plugin is told.
  expect(await config('limit=5')).toEqual({ status: 0, out: 'app limit = 5\n', err: '' })
  await expect.poll(() => seen().changes.at(-1)?.app, { timeout: 10_000 }).toEqual({ limit: 5 })
  const appJson = (): { pluginSettings?: Record<string, unknown> } =>
    JSON.parse(readFileSync(join(cockpit.dataDir, 'app.json'), 'utf8')) as { pluginSettings?: Record<string, unknown> }
  // app.json is written a moment later (the registry debounces its writes).
  await expect.poll(() => appJson().pluginSettings?.[ID], { timeout: 5_000 }).toEqual({ limit: 5 })

  // A project field goes to this project (the scope that declares it), text kept as a string.
  expect(await config('board=dev')).toEqual({ status: 0, out: 'project board = "dev"\n', err: '' })
  await expect.poll(() => seen().changes.at(-1)?.project, { timeout: 10_000 }).toEqual({ board: 'dev' })
  expect((await config()).out).toBe(
    'app limit = 5\napp token = not set\nglobal board = "main"\nproject board = "dev"\n# project: overrides board; the rest use the global value\n'
  )

  // Back to the global value, then a new global value reaches this project (design-next §5.2).
  expect(await config('--use-global', 'board')).toEqual({ status: 0, out: 'project board = "main"\n', err: '' })
  await expect.poll(() => seen().changes.at(-1)?.project, { timeout: 10_000 }).toEqual({ board: 'main' })
  expect(await config('--scope', 'global', 'board=team')).toEqual({ status: 0, out: 'global board = "team"\n', err: '' })
  await expect.poll(() => seen().changes.at(-1)?.project, { timeout: 10_000 }).toEqual({ board: 'team' })
  const globals = (): unknown =>
    (JSON.parse(readFileSync(join(cockpit.dataDir, 'app.json'), 'utf8')) as { pluginProjectDefaults?: Record<string, unknown> }).pluginProjectDefaults?.[ID]
  await expect.poll(globals, { timeout: 5_000 }).toEqual({ board: 'team' })

  // Refusals: exit 1 with the reason, nothing stored.
  const bad = await config('limit=0')
  expect(bad.status).toBe(1)
  expect(bad.err).toMatch(/^ccc: test\.hostconfig: nothing was stored, the app settings fail the schema: .*limit/)
  const secret = await config('token=abc')
  expect(secret).toEqual({ status: 1, out: '', err: 'ccc: token is a secret field: ccc never handles secret values, set it in Settings > Plugins\n' })
  const unknown = await config('colour=red')
  expect(unknown.status).toBe(1)
  expect(unknown.err).toContain('test.hostconfig has no setting colour')
  const noPlugin = await ccc(cockpit, ['plugin', 'config', '--project', cockpit.projectDir, 'test.nosuch'])
  expect(noPlugin).toEqual({ status: 1, out: '', err: 'ccc: unknown plugin: test.nosuch\n' })
  expect(appJson().pluginSettings?.[ID]).toEqual({ limit: 5 })

  // A usage error is exit 2, before anything reaches the app.
  expect((await config('--scope', 'everywhere', 'limit=2')).status).toBe(2)
})
