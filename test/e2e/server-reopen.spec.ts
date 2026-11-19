// The reopen notice of a macOS server (reopen-notice.ts, plan 20261119-server-mode-mac T5). A test
// run answers the box from the env, so `app.emit('activate')` stands for the person's reopen.
import { expect, test } from '@playwright/test'
import { SECOND_LAUNCH_ANSWER_ENV } from '../../src/main/second-launch'
import { expectMainAlive, launchServer, type Server } from './server-fixtures'

test.skip(process.platform !== 'darwin', 'the reopen notice is macOS server mode only')

let server: Server | undefined

test.afterEach(async () => {
  await server?.close()
  server = undefined
})

test('reopen: no notice after start; Cancel leaves the server running', async () => {
  test.setTimeout(90_000)
  server = await launchServer({ env: { [SECOND_LAUNCH_ANSWER_ENV]: 'cancel' } })
  expect(await server.cockpit.hook<number>('reopenNotices')).toBe(0)
  await server.cockpit.app.evaluate(({ app }) => {
    app.emit('activate')
  })
  await expect.poll(() => server?.cockpit.hook<number>('reopenNotices')).toBe(1)
  await expectMainAlive(server)
})

test('reopen: Stop exits with status 0', async () => {
  test.setTimeout(90_000)
  server = await launchServer({ env: { [SECOND_LAUNCH_ANSWER_ENV]: 'stop' } })
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) =>
    server?.cockpit.app.process().once('exit', (code, signal) => resolve({ code, signal }))
  )
  // The evaluate may reject as the process goes away under it: the exit is the assertion.
  void server.cockpit.app
    .evaluate(({ app }) => {
      app.emit('activate')
    })
    .catch(() => undefined)
  expect(await exited).toEqual({ code: 0, signal: null })
})
