// Rooms Task 17: a plugin's room end to end, through the real built `ccc` and the fake `claude`'s hooks (design-rooms.md
// §1-§4). A fixture plugin (rooms-test) makes a room, seeds bob's kickoff doc and opens alice (coordinator), bob and
// carol. The fake plays Claude: after a paste it runs `ccc room read` and ends its turn a moment later
// (FAKE_CLAUDE_ON_PASTE), and a Stop the hook blocks continues with a read and a busy stretch (FAKE_CLAUDE_ON_BLOCK,
// held until the spec releases it); every `/ccc` run and every block is a line in FAKE_CLAUDE_RUN_LOG, so the spec tells the tabs apart by session id.
// The person types only into alice and bob, which makes them typed; carol stays untouched until the restart.
//
//   1. alice sends bob a message: bob, waiting and untyped, gets the fixed pointer pasted by the gate and reads the
//      fenced text; docs: alice puts shared and private docs, bob gets the kickoff and the shared one, and alice's
//      private doc answers exactly like a missing one.
//   2. carol, working on a prompt, gets a message (held, not waiting); her Stop is answered with the pointer through
//      the real `ccc hook Stop` (inside its budget), she reads in the continued turn and stays `working` meanwhile.
//   3. bob sends alice (typed, no mark) a message: only the badge, no paste and no Stop block; the person's mark on
//      her tab delivers the pointer and she reads.
//   4. restart: the members come back on their new tab ids, typed, and the room comes back paused.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HostStatus } from '../../src/main/plugins/host-manager'
import type { TabInfo } from '../../src/shared/ipc'
import { pointerText } from '../../src/shared/room-pointer'
import { expect, launchCockpit, test, type Cockpit } from './fixtures'

const PLUGIN = 'test.rooms'
const FIXTURE = join(__dirname, '..', 'fixtures', 'plugins', 'rooms-test')
/** How long a turn started by a paste lasts before the fake ends it: room for a send to land while carol works. */
const PASTE_TURN_MS = 4000

interface Entry {
  tabId: string
  sessionId?: string
  status: string
  typed: boolean
  draft?: boolean
  settling?: boolean
  held?: number
}
interface Run {
  session: string
  args?: string[]
  status?: number | null
  stdout?: string
  stderr?: string
  block?: string
  unknown?: string
}
interface Seen {
  error?: string
  roomId?: string
  alice?: string
  bob?: string
  carol?: string
  toCarol?: Array<{ to: string; path: string; why?: string }>
  rooms?: Array<{ id: string; title: string; paused: boolean; members: number }>
  members?: Array<{ name: string; coordinator: boolean; tabId?: string; held: number }>
}

const run = (c: Cockpit, command: string): Promise<unknown> => c.hook('runPluginCommand', c.projectDir, `${PLUGIN}/${command}`)
const seen = (c: Cockpit): Seen => JSON.parse(readFileSync(join(c.root, 'home', 'rooms-test.json'), 'utf8'))
/** Runs a fixture command and fails on what it threw. */
async function command(c: Cockpit, name: string): Promise<Seen> {
  await run(c, name)
  const s = seen(c)
  expect(s.error).toBeUndefined()
  return s
}
const tabsOf = (c: Cockpit): Promise<TabInfo[]> => c.hook<TabInfo[]>('tabs', c.projectDir)
const tabIdOf = async (c: Cockpit, name: string): Promise<string> => {
  const tab = (await tabsOf(c)).find((t) => t.room?.name === name)
  if (!tab) throw new Error(`no tab of member ${name}`)
  return tab.id
}
const entryOf = async (c: Cockpit, name: string): Promise<Entry> => {
  const tabId = await tabIdOf(c, name)
  const entry = (await c.hook<Entry[]>('sessions', c.projectDir)).find((e) => e.tabId === tabId)
  if (!entry) throw new Error(`no session of member ${name}`)
  return entry
}
const statusOf = async (c: Cockpit, name: string): Promise<string> => (await entryOf(c, name)).status
const sessionOf = async (c: Cockpit, name: string): Promise<string> => {
  await expect.poll(async () => (await entryOf(c, name)).sessionId, { timeout: 15_000 }).toMatch(/^fake-session-\d+$/)
  return (await entryOf(c, name)).sessionId!
}
function runsIn(file: string): Run[] {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return [] // nothing run yet
  }
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Run)
}
/** The `ccc` runs of one session whose args start with `prefix`, oldest first. */
const cccRuns = (file: string, session: string, ...prefix: string[]): Run[] =>
  runsIn(file).filter((r) => r.session === session && r.args !== undefined && prefix.every((p, i) => r.args![i] === p))
const blocksOf = (file: string, session: string): string[] =>
  runsIn(file).flatMap((r) => (r.session === session && r.block !== undefined ? [r.block] : []))
const memberTab = (c: Cockpit, name: string) =>
  c.page.locator('.tab', { has: c.page.locator('.tab-room', { hasText: new RegExp(`^${name}$`) }) })
/** Show a member's tab (a click on the tab itself is not the person's input) and type a line into its terminal. */
async function typeIn(c: Cockpit, name: string, line: string): Promise<void> {
  await memberTab(c, name).getByRole('tab').click()
  await c.typeLine(line)
}
const paste = (text: string): string => `\x1b[200~${text}\x1b[201~`

test('a plugin room through the real ccc: gate pointer, Stop pointer, typed tab and the mark, restart', async () => {
  test.setTimeout(180_000)
  const logDir = mkdtempSync(join(tmpdir(), 'ccc-rooms-e2e-'))
  const runLog = join(logDir, 'runs.jsonl')
  const release = join(logDir, 'release-block-turn')
  const env = {
    FAKE_CLAUDE_RUN_LOG: runLog,
    FAKE_CLAUDE_ON_PASTE: `/ccc room read\n/later ${PASTE_TURN_MS} /stop`,
    // The continued turn stays busy until the spec has seen it `working` and creates the release file.
    FAKE_CLAUDE_ON_BLOCK: `/ccc room read\n/waitfile ${release}`
  }
  const first = await launchCockpit({ env })
  const root = first.cockpit.root
  let before: Seen
  try {
    const c = first.cockpit
    await c.hook('linkPlugin', FIXTURE)
    await c.hook('enablePlugin', c.projectDir, PLUGIN)
    await expect
      .poll(() => c.hook<HostStatus>('hostStatus', c.projectDir), { timeout: 15_000 })
      .toMatchObject({ running: true, plugins: [{ id: PLUGIN, state: 'active' }] })
    before = await command(c, 'open')
    await expect
      .poll(async () => (await tabsOf(c)).map((t) => t.room?.name), { timeout: 15_000 })
      .toEqual(['alice', 'bob', 'carol'])
    // Waiting, and past the gate's settle window after SessionStart (a send inside it is held, then offered when it ends:
    // room-service.test.ts covers that; here bob's answer is to say `delivered`).
    for (const name of ['alice', 'bob', 'carol']) {
      await expect
        .poll(async () => ((e) => [e.status, e.settling === true])(await entryOf(c, name)), { timeout: 15_000 })
        .toEqual(['waiting', false])
    }
    const [alice, bob, carol] = [await sessionOf(c, 'alice'), await sessionOf(c, 'bob'), await sessionOf(c, 'carol')]

    // 1. alice sends bob a message. bob waits for input and nobody typed in his tab: the gate pastes the fixed pointer
    // (no message text), and his turn reads the text, fenced, from alice.
    await typeIn(c, 'alice', '/ccc room send bob hello from alice')
    await expect.poll(() => cccRuns(runLog, alice, 'room', 'send').length).toBe(1)
    expect(cccRuns(runLog, alice, 'room', 'send')[0]).toMatchObject({ status: 0, stdout: 'bob: delivered\n' })
    await expect.poll(() => c.pastes()).toEqual([paste(pointerText(1))])
    await expect.poll(() => cccRuns(runLog, bob, 'room', 'read').length).toBe(1)
    const read = cccRuns(runLog, bob, 'room', 'read')[0]!
    expect(read.status).toBe(0)
    expect(read.stdout).toMatch(/^\[cockpit room "E2E room" ([0-9a-f]{16})\] from alice \(a room member, not the person\):\n\| hello from alice\n\[end \1\]\n$/)
    // Read and acked: nothing is held for bob any more, and his turn ends with no Stop block.
    await expect.poll(() => statusOf(c, 'bob'), { timeout: 10_000 }).toBe('waiting')
    expect((await entryOf(c, 'bob')).held).toBeUndefined()
    expect(blocksOf(runLog, bob)).toEqual([])
    expect((await entryOf(c, 'bob')).typed).toBe(false)

    // Docs across members: alice (coordinator) writes a shared doc and a private one; bob reads his kickoff (seeded by
    // the plugin before his tab opened) and the shared doc; alice's private doc answers exactly like a missing one.
    await typeIn(c, 'alice', '/ccc room doc put shared/plan.md - <<< plan from alice')
    await typeIn(c, 'alice', '/ccc room doc put members/alice/notes.md - <<< private to alice')
    await expect.poll(() => cccRuns(runLog, alice, 'room', 'doc', 'put').map((r) => r.status)).toEqual([0, 0])
    await typeIn(c, 'bob', '/ccc room doc ls')
    await typeIn(c, 'bob', '/ccc room doc get members/bob/kickoff.md')
    await typeIn(c, 'bob', '/ccc room doc get shared/plan.md')
    await typeIn(c, 'bob', '/ccc room doc get members/alice/notes.md')
    await typeIn(c, 'bob', '/ccc room doc get members/alice/missing.md')
    await expect.poll(() => cccRuns(runLog, bob, 'room', 'doc').length).toBe(5)
    const [ls, kickoff, plan, refused, missing] = cccRuns(runLog, bob, 'room', 'doc')
    expect(ls!.stdout).toBe('members/bob/kickoff.md\t16\nshared/plan.md\t15\n')
    expect(kickoff).toMatchObject({ status: 0, stdout: 'kickoff for bob\n' })
    expect(plan).toMatchObject({ status: 0, stdout: 'plan from alice' })
    expect(refused!.status).toBe(1)
    expect(refused!.stdout).toBe('')
    expect(refused!.stderr).toContain('no such doc')
    expect({ status: missing!.status, stdout: missing!.stdout, stderr: missing!.stderr }).toEqual({
      status: refused!.status,
      stdout: refused!.stdout,
      stderr: refused!.stderr
    })
    expect(refused!.stderr).not.toContain('alice')

    // 2. carol works on a prompt (a plugin's ctx.sessions.send); a message for her now is held, not waiting.
    await command(c, 'work')
    await expect.poll(() => statusOf(c, 'carol')).toBe('working')
    const toCarol = (await command(c, 'to-carol')).toCarol
    expect(toCarol).toEqual([expect.objectContaining({ to: 'carol', path: 'held', why: 'not-waiting' })])
    expect((await entryOf(c, 'carol')).held).toBe(1)
    // Her turn ends: the real `ccc hook Stop` gets main's block within its budget, acks, prints the pointer; Claude
    // goes on with the read, and the tab stays working through the continued turn.
    await expect.poll(() => blocksOf(runLog, carol), { timeout: PASTE_TURN_MS + 10_000 }).toEqual([pointerText(1)])
    await expect.poll(() => cccRuns(runLog, carol, 'room', 'read').length).toBe(2)
    expect(cccRuns(runLog, carol, 'room', 'read')[1]!.stdout).toMatch(
      /^\[cockpit room "E2E room" [0-9a-f]{16}\] from plugin \(the plugin running this room, not the person\):\n\| hello carol\n/
    )
    expect(await statusOf(c, 'carol')).toBe('working')
    expect((await entryOf(c, 'carol')).held).toBeUndefined()
    // The busy stretch over (the spec ends it), the next Stop has nothing to say: waiting, one block in all, no paste of
    // the pointer.
    writeFileSync(release, '')
    expect(runsIn(runLog).filter((r) => r.unknown !== undefined)).toEqual([]) // no scripted line the fake did not know
    await expect.poll(() => statusOf(c, 'carol'), { timeout: 10_000 }).toBe('waiting')
    expect(blocksOf(runLog, carol)).toHaveLength(1)
    expect(c.pastes()).toEqual([paste(pointerText(1)), paste('start on the task')])
    expect((await entryOf(c, 'carol')).typed).toBe(false)

    // 3. alice is typed and has no mark: bob's message for her is held behind the badge, nothing is pasted.
    expect((await entryOf(c, 'alice')).typed).toBe(true)
    await typeIn(c, 'bob', '/ccc room send alice hello from bob')
    await expect.poll(() => cccRuns(runLog, bob, 'room', 'send').length).toBe(1)
    expect(cccRuns(runLog, bob, 'room', 'send')[0]!.stdout).toContain('alice: held (')
    const badge = memberTab(c, 'alice').getByRole('button', { name: '1 room message waiting: deliver now' })
    await expect(badge).toHaveText('1')
    // Her own turn ends with the message waiting: no Stop block either (a prompt first clears the draft bit her keys set).
    await typeIn(c, 'alice', `/later 1500 /stop`)
    await c.typeLine('/prompt mine')
    await expect.poll(() => statusOf(c, 'alice')).toBe('working')
    await expect.poll(() => statusOf(c, 'alice'), { timeout: 10_000 }).toBe('waiting')
    expect((await entryOf(c, 'alice')).draft).not.toBe(true)
    expect(blocksOf(runLog, alice)).toEqual([])
    expect(c.pastes()).toHaveLength(2)
    await expect(badge).toHaveText('1')

    // The person's mark on her tab: what is held goes in at once, as the pointer, and her turn reads it.
    await memberTab(c, 'alice').getByRole('tab').click({ button: 'right' })
    await c.page.getByRole('menuitemcheckbox', { name: 'Deliver room messages automatically' }).click()
    await expect.poll(async () => (await tabsOf(c)).find((t) => t.room?.name === 'alice')?.room).toMatchObject({ mark: true })
    await expect.poll(() => c.pastes()).toHaveLength(3)
    expect(c.pastes()[2]).toBe(paste(pointerText(1)))
    await expect.poll(() => cccRuns(runLog, alice, 'room', 'read').length).toBe(1)
    expect(cccRuns(runLog, alice, 'room', 'read')[0]!.stdout).toMatch(/\] from bob \(a room member, not the person\):\n\| hello from bob\n/)
    await expect(badge).toHaveCount(0)
    await expect.poll(() => statusOf(c, 'alice'), { timeout: PASTE_TURN_MS + 10_000 }).toBe('waiting')
  } finally {
    await first.close({ keepFiles: true })
  }

  // 4. Restart: the tabs come back with new ids and their membership (matched by room and name, never the tab id);
  // the room comes back paused, and restored members count as typed.
  const second = await launchCockpit({ root, folderArg: false, env })
  try {
    const c = second.cockpit
    await expect
      .poll(async () => (await tabsOf(c)).map((t) => t.room && { name: t.room.name, coordinator: t.room.coordinator }), {
        timeout: 15_000
      })
      .toEqual([
        { name: 'alice', coordinator: true },
        { name: 'bob', coordinator: false },
        { name: 'carol', coordinator: false }
      ])
    const ids = (await tabsOf(c)).map((t) => t.id)
    for (const old of [before.alice, before.bob, before.carol]) expect(ids).not.toContain(old)
    await expect
      .poll(() => c.hook<HostStatus>('hostStatus', c.projectDir), { timeout: 15_000 })
      .toMatchObject({ running: true, plugins: [{ id: PLUGIN, state: 'active' }] })
    const state = await command(c, 'state')
    expect(state.rooms).toEqual([expect.objectContaining({ id: before.roomId, title: 'E2E room', paused: true, members: 3 })])
    expect(state.members?.map((m) => [m.name, m.tabId])).toEqual([
      ['alice', ids[0]],
      ['bob', ids[1]],
      ['carol', ids[2]]
    ])
    for (const name of ['alice', 'bob', 'carol']) {
      await expect.poll(async () => (await entryOf(c, name)).typed, { timeout: 15_000 }).toBe(true)
    }
    // Paused: a send still queues but nothing is delivered.
    await expect.poll(() => statusOf(c, 'carol'), { timeout: 15_000 }).toBe('waiting')
    const pastesBefore = c.pastes().length
    expect((await command(c, 'to-carol')).toCarol).toEqual([expect.objectContaining({ to: 'carol', path: 'held', why: 'paused' })])
    await expect(memberTab(c, 'carol').getByRole('button', { name: '1 room message waiting: deliver now' })).toHaveText('1')
    expect(c.pastes()).toHaveLength(pastesBefore)
  } finally {
    await second.close()
    rmSync(logDir, { recursive: true, force: true })
  }
})
