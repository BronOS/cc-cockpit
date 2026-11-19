// Guests in server mode (design-guests §12, D-25, D-28; task 07b): a person on the server invites from
// the shell with `ccc web invite` (server mode only), the link works in a plain browser and from a raw
// client, `ccc web guests` lists the guest and `ccc web kick` ends it (4460, within 1 s of the reply).
// Linux only today, as every server-mode spec: written now (D-28) and run once server mode runs on macOS.
import { CLOSE, parseInviteFragment } from '../../src/shared/web-protocol'
import { expect, test } from './fixtures'
import { rawSocket, redeemOk, session } from './guest-fixtures'
import { ccc, launchServer, type Server } from './server-fixtures'
import { openBrowser } from './web-fixtures'

test.skip(process.platform !== 'linux', 'server mode runs on Linux only (D-28: until it runs on macOS)')

let server: Server | undefined
test.afterEach(async () => {
  await server?.close()
  server = undefined
})

test('server mode: ccc web invite makes a link that opens the project as a guest; ccc web guests lists it; ccc web kick ends it', async () => {
  test.setTimeout(120_000)
  server = await launchServer({ mode: 'link' })
  const { origin, projectId } = server

  // The link alone on stdout, the warning (this server listens on loopback only) on stderr.
  const made = await ccc(server, ['web', 'invite', '--project', projectId, '--name', 'Sam', '--role', 'read', '--json'])
  expect(made.code, made.stderr).toBe(0)
  const invite = JSON.parse(made.stdout) as { link: string; inviteId: string; guestId: string; warning?: string }
  expect(invite.link.startsWith(`${origin}/#i=`)).toBe(true)
  // Never logged, never in the access log: only ids there.
  const token = parseInviteFragment(invite.link.slice(invite.link.indexOf('#')))?.token ?? ''
  expect(token).not.toBe('')

  // A second invite for a plain browser: one device per invite.
  const browserInvite = await ccc(server, ['web', 'invite', '--project', projectId, '--name', 'Tess', '--role', 'write'])
  expect(browserInvite.code, browserInvite.stderr).toBe(0)
  const browser = await openBrowser(browserInvite.stdout.trim())
  try {
    await expect(browser.page).toHaveURL(`${origin}/?project=${encodeURIComponent(projectId)}`, { timeout: 20_000 })

    const guest = await redeemOk(origin, token)
    expect((await session(guest)).guest).toEqual({ name: 'Sam', role: 'read', project: projectId })
    const socket = await rawSocket(guest)
    await socket.next((f) => f.t === 'ready')

    const listed = await ccc(server, ['web', 'guests', '--json'])
    expect(listed.code, listed.stderr).toBe(0)
    const rows = JSON.parse(listed.stdout) as Array<{ id: string; name: string; role: string }>
    expect(rows.map((r) => [r.name, r.role]).sort()).toEqual([['Sam', 'read'], ['Tess', 'write']])

    const kicked = await ccc(server, ['web', 'kick', 'Sam'])
    const repliedAt = Date.now()
    expect(kicked.code, kicked.stderr).toBe(0)
    const closed = await socket.closed
    expect(closed.code).toBe(CLOSE.kicked)
    expect(closed.at - repliedAt).toBeLessThan(1000)
    expect((await session(guest)).guestEnded).toBe(true)

    // The other guest is untouched.
    await expect(browser.page).toHaveURL(`${origin}/?project=${encodeURIComponent(projectId)}`)
    const after = JSON.parse((await ccc(server, ['web', 'guests', '--json'])).stdout) as Array<{ name: string }>
    expect(after.map((r) => r.name)).toEqual(['Tess'])
  } finally {
    await browser.close()
  }
})
