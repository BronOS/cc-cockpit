// Task 14: Claude tab status end to end. The fake `claude` reads --settings, runs the hook
// commands it names (the generated bin/ccc wrapper under Electron-as-Node, with the tab's token and
// socket from its env, not from PATH) and main's session registry follows. Asserted through the
// `sessions` test hook, and through the `sessions.snapshot` event a window receives.
import { expect, test, type Cockpit } from './fixtures'

interface Entry {
  tabId: string
  status: string
  tool?: string
  lastPrompt?: string
  files: string[]
  sessionId?: string
  exitCode?: number
}

const entries = (c: Cockpit): Promise<Entry[]> => c.hook<Entry[]>('sessions', c.projectDir)

async function expectEntry(c: Cockpit, fields: Partial<Entry>): Promise<void> {
  await expect
    .poll(async () => (await entries(c))[0], { timeout: 15_000 })
    .toMatchObject(fields)
}

test('hook events from the fake claude drive the tab status', async ({ cockpit }) => {
  // Collect what the window is told, through the preload allow-list.
  await cockpit.page.evaluate(() => {
    const w = globalThis as unknown as { __snaps: unknown[]; cockpit: { on(c: string, cb: (p: unknown) => void): void } }
    w.__snaps = []
    w.cockpit.on('sessions.snapshot', (p) => w.__snaps.push(p))
  })

  await cockpit.newTab('claude')
  // SessionStart arrives on its own once the fake has printed its banner.
  await expectEntry(cockpit, { status: 'idle' })
  const [first] = await entries(cockpit)
  expect(first?.sessionId).toMatch(/^fake-session-\d+$/)

  await cockpit.typeLine('/prompt fix the build')
  await expectEntry(cockpit, { status: 'working', lastPrompt: 'fix the build' })

  await cockpit.typeLine('/tool Bash')
  await expectEntry(cockpit, { status: 'working', tool: 'Bash' })

  // A working dot pulses (a ring off ::after), except when the OS asks for less motion.
  const ring = (): Promise<string> =>
    cockpit.page
      .locator('.tab .status-dot[data-status="working"]')
      .evaluate((el) => (globalThis as unknown as { getComputedStyle(e: unknown, p: string): { animationName: string } }).getComputedStyle(el, '::after').animationName)
  await expect.poll(ring).toBe('cc-status-pulse')
  await cockpit.page.emulateMedia({ reducedMotion: 'reduce' })
  await expect.poll(ring).toBe('none')
  await cockpit.page.emulateMedia({ reducedMotion: null })

  const file = `${cockpit.projectDir}/src/a.ts`
  await cockpit.typeLine(`/edit ${file}`)
  await expectEntry(cockpit, { files: [file] })

  // Permission prompt, then the next tool after the approval, then the end of the turn.
  await cockpit.typeLine('/permission')
  await expectEntry(cockpit, { status: 'needs-permission' })
  await cockpit.typeLine('/tool Read')
  await expectEntry(cockpit, { status: 'working', tool: 'Read' })

  await cockpit.typeLine('/stop')
  await expectEntry(cockpit, { status: 'waiting' })
  expect((await entries(cockpit))[0]?.tool).toBeUndefined()

  // The session id the hook reported is what a restart resumes.
  const tabs = await cockpit.hook<Array<{ sessionId?: string }>>('tabs', cockpit.projectDir)
  expect(tabs[0]?.sessionId).toBe(first?.sessionId)

  // The window got its own view: the strip fields of every tab, plus the full entry of its own
  // project's tab (Task 16; the cross-project privacy split is in top-strip.spec.ts). Polled:
  // snapshots go out throttled (trailing edge, up to 100 ms later), so main's registry can already
  // say `waiting` while the window's last snapshot is still the `working` one before the Stop.
  const snaps = (): Promise<Array<{ strip: unknown[]; own: unknown[] }>> =>
    cockpit.page.evaluate(
      () => (globalThis as unknown as { __snaps: Array<{ strip: unknown[]; own: unknown[] }> }).__snaps
    )
  await expect
    .poll(async () => (await snaps()).at(-1)?.strip, { timeout: 15_000 })
    .toEqual([{ tabId: first?.tabId, projectName: expect.any(String), status: 'waiting' }])
  await expect
    .poll(async () => (await snaps()).at(-1)?.own, { timeout: 15_000 })
    .toMatchObject([
      { tabId: first?.tabId, status: 'waiting', lastPrompt: 'fix the build', files: [file], queue: [] }
    ])
  // The strip part never carries the private fields.
  expect(JSON.stringify((await snaps()).map((s) => s.strip))).not.toMatch(/fix the build|a\.ts/)

  // The process ends: the entry ends with its exit code.
  await cockpit.typeLine('/exit 3')
  await expectEntry(cockpit, { status: 'ended', exitCode: 3 })
})
