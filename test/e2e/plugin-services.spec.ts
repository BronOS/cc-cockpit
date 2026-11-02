// Plugin services end to end (plugin-services plan, Task 7): real fixture plugins in the real plugin
// host. The consumer (svc-consumer) registers a command "call" that calls greet('world') on the
// service "greet" and listens for its "greeted" event; it records answers, error texts and events
// in $HOME/svc-consumer.json, which the test reads. The command is run through the runPluginCommand
// test hook, and enabling, disabling and picking go through the same IPC channels the Settings
// screen uses. A change restarts the project's host, so each step waits for a fresh consumer file.
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './fixtures'

const fixture = (name: string): string => join(__dirname, '..', 'fixtures', 'plugins', name)
const CONSUMER = 'test.svcconsumer'
const ONE = 'test.svcprovider'
const TWO = 'test.svcprovider2'

type Seen = {
  calls: Array<{ ok: true; value: string } | { ok: false; error: string }>
  events: Array<{ name: string; by: string }>
}

test('plugins call each other and hear events through ctx.services', async ({ cockpit }) => {
  const { page } = cockpit
  const seenFile = join(cockpit.root, 'home', 'svc-consumer.json')
  const seen = (): Seen => JSON.parse(readFileSync(seenFile, 'utf8')) as Seen
  const invoke = (channel: string, req: unknown): Promise<unknown> =>
    page.evaluate(`window.cockpit.invoke(${JSON.stringify(channel)}, ${JSON.stringify(req)})`)
  const setEnabled = (pluginId: string, enabled: boolean): Promise<unknown> =>
    invoke('settings.projectPluginEnable', { pluginId, enabled })

  // The consumer's file is deleted before a change and written by the new host's activate, so
  // its presence says the restarted host is up. The command may not be registered at that moment
  // (activate returned, the registration reaches main a moment later): retry the run.
  const ready = (): Promise<void> => expect.poll(() => existsSync(seenFile), { timeout: 15_000 }).toBe(true)
  const callOnce = async (): Promise<Seen['calls'][number]> => {
    await ready()
    const before = seen().calls.length
    await expect
      .poll(
        async () => {
          try {
            await cockpit.hook('runPluginCommand', cockpit.projectDir, `${CONSUMER}/call`)
            return true
          } catch {
            return false
          }
        },
        { timeout: 15_000 }
      )
      .toBe(true)
    await expect.poll(() => seen().calls.length, { timeout: 10_000 }).toBe(before + 1)
    return seen().calls[before]!
  }
  const restartWith = async (change: () => Promise<unknown>): Promise<void> => {
    rmSync(seenFile, { force: true })
    await change()
  }

  for (const name of ['svc-consumer', 'svc-provider', 'svc-provider-2']) await cockpit.hook('linkPlugin', fixture(name))

  // No provider yet: the consumer still runs, and its call reports the missing provider.
  await restartWith(() => cockpit.hook('enablePlugin', cockpit.projectDir, CONSUMER) as Promise<unknown>)
  expect(await callOnce()).toEqual({ ok: false, error: 'no enabled plugin in this project provides service "greet"' })

  // One provider: the call returns its answer and the event it emitted reaches the consumer.
  await restartWith(() => cockpit.hook('enablePlugin', cockpit.projectDir, ONE) as Promise<unknown>)
  expect(await callOnce()).toEqual({ ok: true, value: 'hello world from one' })
  await expect.poll(() => seen().events, { timeout: 10_000 }).toEqual([{ name: 'world', by: 'one' }])

  // The provider disabled again: the consumer survives the restart and reports the error.
  await restartWith(() => setEnabled(ONE, false))
  expect(await callOnce()).toEqual({ ok: false, error: 'no enabled plugin in this project provides service "greet"' })
  expect(seen().events).toEqual([])

  // Two providers and no pick: the call refuses, naming both.
  await restartWith(() => setEnabled(ONE, true))
  expect((await callOnce()).ok).toBe(true)
  await restartWith(() => setEnabled(TWO, true))
  const unpicked = await callOnce()
  expect(unpicked.ok).toBe(false)
  expect(unpicked).toMatchObject({ error: expect.stringContaining('both provide service "greet"') })

  // The pick decides, and changing it switches the answer (and the event's origin).
  await restartWith(() => invoke('settings.pluginServiceProvider', { service: 'greet', pluginId: TWO }))
  expect(await callOnce()).toEqual({ ok: true, value: 'hello world from two' })
  await expect.poll(() => seen().events, { timeout: 10_000 }).toEqual([{ name: 'world', by: 'two' }])

  await restartWith(() => invoke('settings.pluginServiceProvider', { service: 'greet', pluginId: ONE }))
  expect(await callOnce()).toEqual({ ok: true, value: 'hello world from one' })
  await expect.poll(() => seen().events, { timeout: 10_000 }).toEqual([{ name: 'world', by: 'one' }])
})
