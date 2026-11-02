// Task 15: the send-text gate end to end. Text sent while the fake claude is working waits in the
// queue; the `/stop` line makes the fake fire a real Stop hook through the generated `ccc`, and
// main then types the queue head into the PTY as ONE bracketed paste, which the fake records
// verbatim and submits (UserPromptSubmit), as Claude does.
import { expect, test, type Cockpit } from './fixtures'

interface Entry {
  tabId: string
  status: string
  lastPrompt?: string
  queue: Array<{ id: string; text: string }>
  delivering: boolean
}

const entry = async (c: Cockpit): Promise<Entry> => {
  const [first] = await c.hook<Entry[]>('sessions', c.projectDir)
  if (!first) throw new Error('no Claude tab yet')
  return first
}

async function expectEntry(c: Cockpit, fields: Partial<Entry>): Promise<void> {
  await expect.poll(() => entry(c).catch(() => undefined), { timeout: 15_000 }).toMatchObject(fields)
}

test('a send while working is queued and delivered on Stop as one bracketed paste', async ({ cockpit }) => {
  await cockpit.newTab('claude')
  await expectEntry(cockpit, { status: 'idle' })

  await cockpit.typeLine('/prompt first task')
  await expectEntry(cockpit, { status: 'working' })
  const { tabId } = await entry(cockpit)

  // Multi-line, with an embedded end marker that must not end the paste early.
  const sent = await cockpit.hook<{ id: string; delivered: boolean }>(
    'send',
    tabId,
    'line one\x1b[201~\nline two'
  )
  expect(sent.delivered).toBe(false)
  await expectEntry(cockpit, { status: 'working', queue: [{ id: sent.id, text: 'line one\nline two' }] })
  // Working: nothing may have been typed.
  expect(cockpit.pastes()).toEqual([])

  await cockpit.typeLine('/stop')
  // The paste arrived as one message: the fake submitted it, so the tab is working on it.
  await expectEntry(cockpit, {
    status: 'working',
    lastPrompt: 'line one\nline two',
    queue: [],
    delivering: false
  })
  expect(cockpit.pastes()).toEqual(['\x1b[200~line one\nline two\x1b[201~'])

  // Waiting with an empty queue and nothing in flight: a send goes straight in.
  await cockpit.typeLine('/stop')
  await expectEntry(cockpit, { status: 'waiting' })
  const direct = await cockpit.hook<{ id: string; delivered: boolean }>('send', tabId, 'second')
  expect(direct.delivered).toBe(true)
  await expectEntry(cockpit, { status: 'working', lastPrompt: 'second', delivering: false })
  expect(cockpit.pastes()).toEqual(['\x1b[200~line one\nline two\x1b[201~', '\x1b[200~second\x1b[201~'])
})

test('a queued text can be cancelled and is never typed', async ({ cockpit }) => {
  await cockpit.newTab('claude')
  await expectEntry(cockpit, { status: 'idle' })
  const { tabId } = await entry(cockpit)

  // Idle is not sendable (a trust dialog may be on screen): queued.
  const sent = await cockpit.hook<{ id: string; delivered: boolean }>('send', tabId, 'never')
  expect(sent.delivered).toBe(false)
  expect(await cockpit.hook<boolean>('cancelQueued', tabId, sent.id)).toBe(true)
  await expectEntry(cockpit, { queue: [] })

  await cockpit.typeLine('/stop')
  await expectEntry(cockpit, { status: 'waiting' })
  await cockpit.waitForTerminalText('FAKE-CLAUDE hook Stop')
  expect(cockpit.pastes()).toEqual([])
})

test('the queued list closes when the queue empties and when another menu opens', async ({ cockpit }) => {
  await cockpit.newTab('claude')
  await expectEntry(cockpit, { status: 'idle' })
  const { tabId } = await entry(cockpit)
  const page = cockpit.page
  const list = page.locator('.queued-list')

  await cockpit.hook('send', tabId, 'first')
  await page.getByRole('button', { name: /^queued 1$/ }).click()
  await expect(list).toBeVisible()

  // Another menu opening closes the list (the New tab button stops its click from bubbling).
  await page.getByRole('button', { name: 'New tab' }).click()
  await expect(list).toHaveCount(0)
  await page.keyboard.press('Escape')

  // The queue empties without the Cancel button: delivered on Stop.
  await page.getByRole('button', { name: /^queued 1$/ }).click()
  await expect(list).toBeVisible()
  await cockpit.typeLine('/stop')
  await expectEntry(cockpit, { status: 'working', queue: [] })
  await expect(page.getByRole('button', { name: /^queued/ })).toHaveCount(0)

  // The next queued text must not pop the list open again.
  await cockpit.hook('send', tabId, 'second')
  await expect(page.getByRole('button', { name: /^queued 1$/ })).toBeVisible()
  await expect(list).toHaveCount(0)
})
