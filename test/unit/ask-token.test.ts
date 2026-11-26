// Task 02 (spec-review S5 A2): an Ask process's token. main/index.ts resolveToken answers an Ask's token as the window
// owner of its project, so a host-only command (ccc web set) from an Ask's env is refused before any handler, as from
// a tab. Real Unix socket under /tmp (macOS's tmpdir can push the path past sun_path).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import type { Socket } from 'node:net'
import { join } from 'node:path'
import { AskService } from '../../src/main/ask/ask-service'
import { connect } from '../../src/main/socket/transport'
import { SocketServer } from '../../src/main/socket/socket-server'
import { LineFramer, encodeRequest, hostOnlyText, parseReply, type Reply, type Request } from '../../src/shared/protocol'

const POSIX = process.platform !== 'win32'
let root: string
let server: SocketServer | undefined
beforeEach(() => {
  root = mkdtempSync(join(POSIX ? '/tmp' : process.env.TEMP!, 'ccc-ask-tok-'))
})
afterEach(async () => {
  await server?.stop()
  server = undefined
  rmSync(root, { recursive: true, force: true })
})

/** One request, one reply, over a fresh connection. */
async function request(path: string, req: Partial<Request> & { cmd: string }): Promise<Reply> {
  const socket: Socket = await connect(path, 1000)
  const framer = new LineFramer()
  try {
    return await new Promise<Reply>((resolve, reject) => {
      socket.on('data', (chunk: Buffer) => {
        const lines = framer.push(chunk)
        if (lines.length > 0) resolve(parseReply(lines[0]!))
      })
      socket.on('error', reject)
      socket.on('close', () => reject(new Error('connection closed')))
      socket.write(encodeRequest({ v: 1, id: 1, args: {}, ...req }))
    })
  } finally {
    socket.destroy()
  }
}

describe("an Ask process's token", () => {
  it("ccc web set from an Ask's env is refused", async () => {
    let askEnv: Record<string, string> = {}
    const asks = new AskService({
      dataDir: root,
      log: () => {},
      overlays: {
        copyOwner: () => 'desktop:1' as never,
        copiesOf: () => [],
        notesOf: () => ({ pluginId: 'a.jira', key: 'k' }),
        openerPluginOf: () => 'a.jira',
        postEnvelope: () => true,
        onCopyReady: () => () => {},
        onCopyEnd: () => () => {},
        partsOf: () => [],
        askContext: () => Promise.resolve({ text: 'doc' })
      },
      projectRoot: () => root,
      projectOfWindow: () => 'proj-a',
      loginEnv: () => Promise.resolve({ PATH: '/usr/bin' }),
      askerOf: () => 'owner',
      openResumeTab: () => 't',
      folderTrusted: () => Promise.resolve(true),
      readHelp: () => Promise.resolve('-p --permission-prompts --input-format --output-format --verbose --include-partial-messages --model --effort --resume'),
      spawn: (_argv, opts) => {
        askEnv = opts.env
        return { write: () => {}, kill: () => {}, exited: new Promise(() => {}) }
      }
    })
    await asks.start({ windowId: 1, projectId: 'proj-a', view: 'desktop:1' as never, person: 'owner' }, { overlayId: 'o', copy: 'c', question: 'q' })
    const token = askEnv.APP_TAB_TOKEN!
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    const path = join(root, 's.sock')
    // As main/index.ts resolveToken: a tab's token first (none here), then an Ask's, as { kind: 'window', projectId }.
    server = new SocketServer({
      path,
      resolveToken: (t) => {
        const ask = asks.resolveToken(t)
        return ask ? { kind: 'window', projectId: ask.projectId } : undefined
      },
      resolveProject: (p) => ({ path: p, projectId: undefined }),
      log: () => {}
    })
    let reached = 0
    server.handle('web.status', () => ++reached)
    server.handle('overlay', (_a, caller) => ({ caller }))
    await server.start()
    expect(await request(path, { token, cmd: 'web.set', args: { mode: 'none' } })).toEqual({ id: 1, ok: false, error: hostOnlyText('web.set') })
    expect(await request(path, { token, cmd: 'web.status' })).toEqual({ id: 1, ok: false, error: hostOnlyText('web.status') })
    // A window command reaches its handler as the Ask's project, with no tab id.
    const reply = await request(path, { token, cmd: 'overlay' })
    expect(reply).toMatchObject({ ok: true, result: { caller: { kind: 'window', projectId: 'proj-a' } } })
    expect((reply as { result: { caller: object } }).result.caller).not.toHaveProperty('tabId')
    expect(reached).toBe(0)
  })
})
