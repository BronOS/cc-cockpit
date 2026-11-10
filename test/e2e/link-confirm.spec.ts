// Plan Task 25 (review): the in-page confirm of `ccc plugin link` while a browser is attached. The
// desktop's dialog has Deny focused and #root inert, Esc denies even after a click moved the focus off
// the buttons, and the terminal gets its focus back. The browser (a Node WebSocket with the device
// cookie) sees the same ask: its Allow is refused, its Deny settles it and takes the desktop's down.
import { request } from 'node:http'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import type { CockpitApi } from '../../src/shared/ipc'
import { expect, test } from './fixtures'

type Frame = { t: string; ch?: string; p?: { requestId?: string }; id?: number; ok?: boolean; v?: unknown }

function post(port: number, path: string, body: unknown): Promise<{ status: number; cookie: string }> {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(body)
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: { Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) }
      },
      (res) => {
        res.resume()
        res.on('end', () => resolve({ status: res.statusCode ?? 0, cookie: String(res.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? '' }))
      }
    )
    req.on('error', reject)
    req.end(text)
  })
}

test('link confirm with a browser attached: desktop dialog focus and Esc, a browser may only Deny', async ({ cockpit }) => {
  test.setTimeout(90_000)
  const { page } = cockpit
  const port = 20000 + Math.floor(Math.random() * 20000)
  const dir = join(cockpit.root, 'devplugin')
  const dialog = page.getByRole('alertdialog', { name: /Link plugin local\.devplugin/ })
  const declined = async (): Promise<number> => ((await cockpit.terminalText()).match(/ccc: declined/g) ?? []).length

  await cockpit.newTab('claude')
  await cockpit.waitForTerminalText('FAKE-CLAUDE banner')
  await cockpit.typeLine(`/ccc plugin new ${dir} --cli devdemo`)
  await cockpit.waitForTerminalText(/FAKE-CLAUDE ccc exit=0 out="created plugin local\.devplugin in /)

  // Web access on, and a browser signed in and attached to this window.
  const { link, projectId } = await page.evaluate(async (p) => {
    const api = (window as unknown as { cockpit: CockpitApi }).cockpit
    await api.invoke('settings.webAccessSet', { value: { port: p, enabled: true } })
    const reply = await api.invoke('settings.webAccessLink')
    const info = await api.invoke('window.info')
    return { link: reply.ok ? reply.link : '', projectId: info.kind === 'project' ? info.project.id : '' }
  }, port)
  const token = link.split('#t=')[1] ?? ''
  expect(token).not.toBe('')
  const signed = await post(port, '/auth/link', { token, name: 'Test phone' })
  expect(signed.status).toBe(200)
  const frames: Frame[] = []
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: `http://127.0.0.1:${port}`, headers: { Cookie: signed.cookie } })
  ws.on('message', (data) => frames.push(JSON.parse(String(data)) as Frame))
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve())
    ws.on('error', reject)
  })
  ws.send(JSON.stringify({ t: 'hello', v: 1, project: projectId }))
  await expect.poll(() => frames.some((f) => f.t === 'ready')).toBe(true)
  let nextId = 1
  const answer = async (requestId: string, allow: boolean): Promise<unknown> => {
    const id = nextId++
    ws.send(JSON.stringify({ t: 'invoke', id, ch: 'links.answer', p: { requestId, allow } }))
    await expect.poll(() => frames.some((f) => f.t === 'result' && f.id === id)).toBe(true)
    return frames.find((f) => f.t === 'result' && f.id === id)?.v
  }
  const askIds = (): string[] => frames.filter((f) => f.t === 'event' && f.ch === 'links.ask').map((f) => f.p?.requestId ?? '')

  try {
    // 1. The desktop shows the dialog: Deny focused, everything behind it inert.
    await cockpit.typeLine(`/ccc plugin link ${dir}`)
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Deny' })).toBeFocused()
    await expect(dialog.getByRole('button', { name: 'Allow' })).toBeVisible()
    await expect(page.locator('#root')).toHaveAttribute('inert', '')
    await expect.poll(askIds).toHaveLength(1)
    // The browser's Allow is refused: the ask keeps waiting for the desktop.
    expect(await answer(askIds()[0]!, true)).toBe(false)
    await expect(dialog).toBeVisible()
    // A click on the text moves the focus off the buttons; Esc still denies.
    await dialog.locator('p').click()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(page.locator('#root')).not.toHaveAttribute('inert')
    await expect.poll(declined).toBe(1)
    // The terminal has its focus back.
    expect(await page.evaluate(() => document.activeElement?.closest('.xterm') !== null)).toBe(true)

    // 2. The browser's Deny settles it and takes the desktop's dialog down.
    await cockpit.typeLine(`/ccc plugin link ${dir}`)
    await expect(dialog).toBeVisible()
    await expect.poll(askIds).toHaveLength(2)
    expect(await answer(askIds()[1]!, false)).toBe(true)
    await expect(dialog).toHaveCount(0)
    await expect(page.locator('#root')).not.toHaveAttribute('inert')
    await expect.poll(declined).toBe(2)

    // 3. The desktop's Allow links it.
    await cockpit.typeLine(`/ccc plugin link ${dir}`)
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Allow' }).click()
    await expect(dialog).toHaveCount(0)
    await cockpit.waitForTerminalText(/FAKE-CLAUDE ccc exit=0 out="linked local\.devplugin \(Devplugin\)/)
  } finally {
    ws.close()
  }
})
