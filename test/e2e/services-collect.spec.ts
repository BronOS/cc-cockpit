// ctx.services.useAll end to end (Inbox plan, Task 3): a collector (svc-collector) reads service
// "greet" from both fixture providers with no pick, hears each one's event with its id, and sees a
// disabled provider leave. The Plugins page's status reports the name as collected only, so it
// shows no pick. The collector records to $HOME/svc-collector.json (see its host.js).
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './fixtures'

const fixture = (name: string): string => join(__dirname, '..', 'fixtures', 'plugins', name)
const COLLECTOR = 'test.svccollector'
const ONE = 'test.svcprovider'
const TWO = 'test.svcprovider2'

type Seen = { rounds: Array<Array<{ from: string; value: string }>>; events: Array<{ by: string; from: string }>; feed: string[] }

test('a collector reads every provider of a service through ctx.services.useAll', async ({ cockpit }) => {
  const { page } = cockpit
  const seenFile = join(cockpit.root, 'home', 'svc-collector.json')
  const seen = (): Seen => JSON.parse(readFileSync(seenFile, 'utf8')) as Seen
  const invoke = (channel: string, req: unknown): Promise<unknown> =>
    page.evaluate(`window.cockpit.invoke(${JSON.stringify(channel)}, ${JSON.stringify(req)})`)
  // As in plugin-services.spec.ts: a change restarts the host; the file's return says it is up,
  // and the command may register a moment after, so the run is retried.
  const collect = async (): Promise<Seen['rounds'][number]> => {
    await expect.poll(() => existsSync(seenFile), { timeout: 15_000 }).toBe(true)
    const before = seen().rounds.length
    await expect
      .poll(
        async () => {
          try {
            await cockpit.hook('runPluginCommand', cockpit.projectDir, `${COLLECTOR}/collect`)
            return true
          } catch {
            return false
          }
        },
        { timeout: 15_000 }
      )
      .toBe(true)
    await expect.poll(() => seen().rounds.length, { timeout: 10_000 }).toBe(before + 1)
    return seen().rounds[before]!
  }
  const restartWith = async (change: () => Promise<unknown>): Promise<void> => {
    rmSync(seenFile, { force: true })
    await change()
  }

  for (const name of ['svc-collector', 'svc-provider', 'svc-provider-2']) await cockpit.hook('linkPlugin', fixture(name))
  await restartWith(() => cockpit.hook('enablePlugin', cockpit.projectDir, COLLECTOR) as Promise<unknown>)
  expect(await collect()).toEqual([])
  await restartWith(() => cockpit.hook('enablePlugin', cockpit.projectDir, ONE) as Promise<unknown>)
  await restartWith(() => cockpit.hook('enablePlugin', cockpit.projectDir, TWO) as Promise<unknown>)

  // Both providers answer, with no pick, and each one's event arrives with its id.
  const both = await collect()
  expect(both.map((r) => r.from).sort()).toEqual([ONE, TWO])
  expect(both.map((r) => r.value).sort()).toEqual(['hello all from one', 'hello all from two'])
  await expect
    .poll(() => seen().events.map((e) => `${e.from}:${e.by}`).sort(), { timeout: 10_000 })
    .toEqual([`${ONE}:one`, `${TWO}:two`].sort())

  // item / gone / sync events arrive from each provider with its id, in the order emitted.
  await expect
    .poll(() => seen().feed.filter((f) => f.endsWith(`:${ONE}`)), { timeout: 10_000 })
    .toEqual([`item:one:${ONE}`, `gone:one:${ONE}`, `sync:one:${ONE}`])
  expect(seen().feed.filter((f) => f.endsWith(`:${TWO}`))).toEqual([`item:two:${TWO}`, `gone:two:${TWO}`, `sync:two:${TWO}`])

  // Only a collector uses "greet": no pick to make, no problem reported.
  const status = (await invoke('settings.pluginServices', {})) as {
    services: Array<{ service: string; collectedOnly: boolean }>
    plugins: Array<{ id: string; problems: unknown[] }>
  }
  expect(status.services.find((s) => s.service === 'greet')).toMatchObject({ collectedOnly: true })
  expect(status.plugins.find((p) => p.id === COLLECTOR)?.problems).toEqual([])

  // A provider disabled leaves the set.
  await restartWith(() => invoke('settings.projectPluginEnable', { pluginId: TWO, enabled: false }))
  expect((await collect()).map((r) => r.from)).toEqual([ONE])
})
