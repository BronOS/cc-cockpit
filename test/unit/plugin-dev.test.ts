// The app side of `ccc plugin link|unlink|list` (plan B Task 6): the dialog rules (sanitized text,
// one pending per window, a few a minute), the socket handlers, and the client against a fake app.
// Sockets live under /tmp: macOS's /var/folders is long enough to push a path past sun_path.
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildRequest, REPLY_TIMEOUT_MS, run } from '../../src/cli/client'
import { displayText, linkDialogInfo, LinkRequestGate, MAX_DIALOG_FIELD, MAX_LINK_INSPECTIONS } from '../../src/main/plugins/link-request'
import {
  pluginLinkHandler,
  pluginListHandler,
  pluginUnlinkHandler,
  type PluginDevOptions,
  type PluginListing
} from '../../src/main/socket/handlers'
import type { Caller } from '../../src/main/socket/socket-server'
import { encodeReply, LineFramer, parseRequest, type Request } from '../../src/shared/protocol'

describe('displayText', () => {
  it('strips controls, line separators and bidi overrides, and trims', () => {
    expect(displayText('  Nice\nPlugin\u0000 ')).toBe('NicePlugin')
    expect(displayText('a\u001b[31mred')).toBe('a[31mred')
    expect(displayText('Safe‮evil⁦x⁩​﻿  !')).toBe('Safeevilx!')
  })

  it('cuts a long text with an ellipsis', () => {
    const long = displayText('x'.repeat(5000))
    expect(long).toHaveLength(MAX_DIALOG_FIELD)
    expect(long.endsWith('…')).toBe(true)
  })

  it('linkDialogInfo cleans every field', () => {
    expect(linkDialogInfo({ id: 'a.b', name: 'N\nAllow?', dir: '/p/‮x' }, 'tab')).toEqual({ id: 'a.b', name: 'NAllow?', path: '/p/x', caller: 'tab' })
  })
})

describe('LinkRequestGate', () => {
  it('allows one pending dialog per window; another window is independent', () => {
    const gate = new LinkRequestGate()
    const release = gate.begin(1)
    expect(() => gate.begin(1)).toThrow(/already open/)
    expect(() => gate.begin(2)()).not.toThrow()
    release()
    gate.begin(1)()
  })

  it('release is idempotent and does not free a newer dialog', () => {
    const gate = new LinkRequestGate()
    const first = gate.begin(1)
    first()
    const second = gate.begin(1)
    first() // a second call of the old release must not free `second`
    expect(() => gate.begin(1)).toThrow(/already open/)
    second()
  })

  it('allows 3 a minute per window, then refuses until the minute has passed', () => {
    let now = 1_000_000
    const gate = new LinkRequestGate(() => now)
    for (let i = 0; i < 3; i++) gate.begin(1)()
    expect(() => gate.begin(1)).toThrow(/too many link requests/)
    gate.begin(2)()
    now += 59_000
    expect(() => gate.begin(1)).toThrow(/too many/)
    now += 2_000
    gate.begin(1)()
  })

  it('a refusal for a pending dialog does not use up the rate', () => {
    let now = 0
    const gate = new LinkRequestGate(() => now)
    const held = gate.begin(1) // 1 used
    for (let i = 0; i < 10; i++) expect(() => gate.begin(1)).toThrow(/already open/)
    held()
    now += 1
    gate.begin(1)() // 2
    gate.begin(1)() // 3
    expect(() => gate.begin(1)).toThrow(/too many/)
  })
})

describe('plugin dev handlers', () => {
  const tab: Caller = { kind: 'session', tabId: 't1', projectId: 'p1' }
  const INFO = { id: 'acme.todo', name: 'Todo', version: '1.0.0', dir: '/real/todo', alreadyLinked: false }

  function options(over: Partial<PluginDevOptions> = {}): PluginDevOptions & {
    confirmLink: ReturnType<typeof vi.fn>
    linkAndEnable: ReturnType<typeof vi.fn>
    unlink: ReturnType<typeof vi.fn>
    inspectLink: ReturnType<typeof vi.fn>
  } {
    return {
      windowIdOf: (projectId: string) => (projectId === 'p1' ? 7 : undefined),
      inspectLink: vi.fn(async () => INFO),
      confirmLink: vi.fn(async () => true),
      linkAndEnable: vi.fn(async () => {}),
      unlink: vi.fn(async () => {}),
      list: () => [],
      ...over
    } as never
  }

  describe('plugin.link', () => {
    it('Allow: shows the sanitized dialog in the caller\'s window, links and enables, answers id and name', async () => {
      const o = options({ inspectLink: vi.fn(async () => ({ ...INFO, name: 'Todo\nAllow all?‮' })) })
      const result = await pluginLinkHandler(o, new LinkRequestGate())({ path: '/some/todo' }, tab, undefined)
      expect(result).toEqual({ id: 'acme.todo', name: 'TodoAllow all?' })
      expect(o.inspectLink).toHaveBeenCalledWith('/some/todo')
      expect(o.confirmLink).toHaveBeenCalledWith(7, { id: 'acme.todo', name: 'TodoAllow all?', path: '/real/todo', caller: 'tab' }, undefined)
      expect(o.linkAndEnable).toHaveBeenCalledWith('p1', { id: 'acme.todo', dir: '/real/todo' })
    })

    it('a window token (a shell or command tab, a terminal overlay) links in its window and reads as a tab', async () => {
      const o = options()
      const result = await pluginLinkHandler(o, new LinkRequestGate())({ path: '/some/todo' }, { kind: 'window', projectId: 'p1' }, undefined)
      expect(result).toEqual({ id: 'acme.todo', name: 'Todo' })
      expect(o.confirmLink).toHaveBeenCalledWith(7, expect.objectContaining({ caller: 'tab' }), undefined)
      expect(o.linkAndEnable).toHaveBeenCalledWith('p1', { id: 'acme.todo', dir: '/real/todo' })
    })

    it('tells the dialog a `--project` caller from outside any tab apart from a tab', async () => {
      const o = options()
      await pluginLinkHandler(o, new LinkRequestGate())({ path: '/some/todo' }, { kind: 'project', path: '/work/p1', projectId: 'p1' }, undefined)
      expect(o.confirmLink).toHaveBeenCalledWith(7, expect.objectContaining({ caller: 'project' }), undefined)
    })

    it('Deny is "declined" and links nothing', async () => {
      const o = options({ confirmLink: vi.fn(async () => false) })
      await expect(pluginLinkHandler(o, new LinkRequestGate())({ path: '/p' }, tab, undefined)).rejects.toThrow(/^declined/)
      expect(o.linkAndEnable).not.toHaveBeenCalled()
    })

    it('a caller that went away while the dialog was open is declined, even after Allow', async () => {
      const gone = new AbortController()
      const o = options({
        confirmLink: vi.fn(async () => {
          gone.abort()
          return true
        })
      })
      await expect(pluginLinkHandler(o, new LinkRequestGate())({ path: '/p' }, tab, gone.signal)).rejects.toThrow(/declined/)
      expect(o.linkAndEnable).not.toHaveBeenCalled()
    })

    it('an invalid plugin is refused with the reason before any dialog', async () => {
      const gate = new LinkRequestGate()
      const o = options({
        inspectLink: vi.fn(async () => {
          throw new Error('invalid plugin: main is missing')
        })
      })
      await expect(pluginLinkHandler(o, gate)({ path: '/p' }, tab, undefined)).rejects.toThrow('invalid plugin: main is missing')
      expect(o.confirmLink).not.toHaveBeenCalled()
      // ...and it used none of the window's dialog budget.
      for (let i = 0; i < 3; i++) gate.begin(7)()
    })

    it('an already linked folder still asks, and linkAndEnable decides at Allow time', async () => {
      // Whether it is linked is not passed on from before the dialog: linkAndEnable (the
      // installer's keepLinked) checks again, since Settings may have linked or unlinked it meanwhile.
      const o = options({ inspectLink: vi.fn(async () => ({ ...INFO, alreadyLinked: true })) })
      await pluginLinkHandler(o, new LinkRequestGate())({ path: '/p' }, tab, undefined)
      expect(o.confirmLink).toHaveBeenCalledTimes(1)
      expect(o.linkAndEnable).toHaveBeenCalledWith('p1', { id: 'acme.todo', dir: '/real/todo' })
    })

    // Review finding (ext round 10): only dialogs counted, so a loop of refused requests (an
    // invalid folder) read a manifest and walked its skills on every call.
    it('at most MAX_LINK_INSPECTIONS requests a minute per window are inspected, dialog or not', async () => {
      let now = 0
      const gate = new LinkRequestGate(() => now)
      const o = options({
        inspectLink: vi.fn(async () => {
          throw new Error('invalid plugin: main is missing')
        })
      })
      const handler = pluginLinkHandler(o, gate)
      for (let i = 0; i < MAX_LINK_INSPECTIONS; i++) await expect(handler({ path: '/p' }, tab, undefined)).rejects.toThrow(/invalid plugin/)
      await expect(handler({ path: '/p' }, tab, undefined)).rejects.toThrow(/too many plugin link requests/)
      expect(o.inspectLink).toHaveBeenCalledTimes(MAX_LINK_INSPECTIONS)
      now += 60_001
      await expect(handler({ path: '/p' }, tab, undefined)).rejects.toThrow(/invalid plugin/)
    })

    it('a second request while one dialog is open in the window is refused, not queued', async () => {
      let answer: (v: boolean) => void = () => {}
      const o = options({ confirmLink: vi.fn(() => new Promise<boolean>((r) => (answer = r))) })
      const handler = pluginLinkHandler(o, new LinkRequestGate())
      const first = handler({ path: '/p' }, tab, undefined)
      await vi.waitFor(() => expect(o.confirmLink).toHaveBeenCalledTimes(1))
      await expect(handler({ path: '/p2' }, tab, undefined)).rejects.toThrow(/already open/)
      expect(o.confirmLink).toHaveBeenCalledTimes(1)
      answer(true)
      await first
      // The slot is free again.
      o.confirmLink.mockResolvedValue(true)
      await handler({ path: '/p3' }, tab, undefined)
    })

    it('at most 3 requests a minute; the slot is also freed when the dialog throws', async () => {
      const o = options({ confirmLink: vi.fn(async () => false) })
      const handler = pluginLinkHandler(o, new LinkRequestGate())
      for (let i = 0; i < 3; i++) await expect(handler({ path: '/p' }, tab, undefined)).rejects.toThrow(/declined/)
      await expect(handler({ path: '/p' }, tab, undefined)).rejects.toThrow(/too many link requests/)
      expect(o.confirmLink).toHaveBeenCalledTimes(3)

      const throwing = options({
        confirmLink: vi.fn(async () => {
          throw new Error('window closed')
        })
      })
      const h2 = pluginLinkHandler(throwing, new LinkRequestGate())
      await expect(h2({ path: '/p' }, tab, undefined)).rejects.toThrow('window closed')
      await expect(h2({ path: '/p' }, tab, undefined)).rejects.toThrow('window closed') // not "already open"
    })

    it('needs a project with an open window and an absolute path', async () => {
      const o = options()
      const handler = pluginLinkHandler(o, new LinkRequestGate())
      await expect(handler({ path: '/p' }, { kind: 'anonymous' }, undefined)).rejects.toThrow(/tab token or --project/)
      await expect(handler({ path: '/p' }, { kind: 'project', projectId: undefined } as Caller, undefined)).rejects.toThrow(/not open/)
      await expect(handler({ path: '/p' }, { kind: 'session', tabId: 't', projectId: 'closed' }, undefined)).rejects.toThrow(/not open/)
      for (const path of [undefined, '', 'relative/dir', '/a\0b', 5]) {
        await expect(handler({ path }, tab, undefined)).rejects.toThrow(/absolute folder path/)
      }
      expect(o.inspectLink).not.toHaveBeenCalled()
    })
  })

  describe('plugin.unlink and plugin.list', () => {
    it('unlink passes the id on; a failure reaches the caller', async () => {
      const o = options()
      expect(await pluginUnlinkHandler(o)({ id: 'acme.todo' }, tab, undefined)).toBeNull()
      expect(o.unlink).toHaveBeenCalledWith('acme.todo')
      o.unlink.mockRejectedValue(new Error('acme.todo is not a linked plugin'))
      await expect(pluginUnlinkHandler(o)({ id: 'acme.todo' }, tab, undefined)).rejects.toThrow('not a linked plugin')
      await expect(pluginUnlinkHandler(o)({ id: 5 }, tab, undefined)).rejects.toThrow(/needs a plugin id/)
      await expect(pluginUnlinkHandler(o)({ id: 'a.b' }, { kind: 'anonymous' }, undefined)).rejects.toThrow(/tab token/)
    })

    it('list answers for the caller\'s project', () => {
      const rows: PluginListing[] = [{ id: 'a.b', version: '1.0.0', source: 'linked', enabled: true, state: 'ok' }]
      const list = vi.fn(() => rows)
      expect(pluginListHandler(options({ list }))({}, tab, undefined)).toBe(rows)
      expect(list).toHaveBeenCalledWith('p1')
      expect(() => pluginListHandler(options({ list }))({}, { kind: 'anonymous' }, undefined)).toThrow(/tab token/)
    })
  })
})

describe('the client against a fake app', () => {
  let root: string
  let sock: string
  let servers: Server[]
  let received: Request[]
  let sockets: Socket[]
  let answer: (r: Request) => { ok: true; result: unknown } | { ok: false; error: string } | undefined

  beforeEach(async () => {
    root = mkdtempSync(join('/tmp', 'cpd-'))
    sock = join(root, 's.sock')
    servers = []
    received = []
    sockets = []
    answer = () => ({ ok: true, result: null })
    await new Promise<void>((resolve) => {
      const server = createServer({ allowHalfOpen: true }, (socket: Socket) => {
        sockets.push(socket)
        const framer = new LineFramer()
        socket.on('data', (chunk: Buffer) => {
          for (const line of framer.push(chunk)) {
            const r = parseRequest(line)
            received.push(r)
            const a = answer(r)
            if (a) socket.write(encodeReply({ id: r.id, ...a }))
          }
        })
        socket.on('error', () => {})
      })
      servers.push(server)
      server.listen(sock, () => resolve())
    })
  })
  afterEach(() => {
    for (const s of servers) s.close()
    rmSync(root, { recursive: true, force: true })
  })

  const TOKEN = 'e'.repeat(64)
  const env = (over: Record<string, string> = {}): Record<string, string> => ({ APP_TAB_TOKEN: TOKEN, CC_COCKPIT_SOCK: sock, ...over })
  const io = (): { o: string; e: string; io: { stdout: (t: string) => void; stderr: (t: string) => void } } => {
    const r = { o: '', e: '', io: { stdout: (t: string) => void (r.o += t), stderr: (t: string) => void (r.e += t) } }
    return r
  }

  it('link sends the absolute path, prints the result, and a Deny is exit 1 "declined"', async () => {
    answer = () => ({ ok: true, result: { id: 'acme.todo', name: 'Todo' } })
    const o = io()
    expect(await run(['plugin', 'link', 'plugins/todo'], env(), Readable.from([]), o.io, '/work')).toBe(0)
    expect(received[0]).toMatchObject({ cmd: 'plugin.link', token: TOKEN, args: { path: '/work/plugins/todo' } })
    expect(o.o).toBe('linked acme.todo (Todo) and enabled it in this project\n')

    answer = () => ({ ok: false, error: 'declined: the plugin was not linked' })
    const d = io()
    expect(await run(['plugin', 'link', '/x'], env(), Readable.from([]), d.io, '/work')).toBe(1)
    expect(d.e).toBe('ccc: declined: the plugin was not linked\n')
  })

  it('link and unlink wait with no reply timeout; list gives up after REPLY_TIMEOUT_MS', async () => {
    answer = () => undefined // the app does not answer until the test says so
    // Only the timers are faked: the sockets stay real.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const turn = (): Promise<void> => new Promise((r) => setImmediate(r))
    const until = async (check: () => boolean): Promise<void> => {
      for (let i = 0; i < 500 && !check(); i++) await turn()
    }
    try {
      const link = run(['plugin', 'link', '/x'], env(), Readable.from([]), io().io, '/w')
      await until(() => received.length === 1 && sockets.length === 1)
      vi.advanceTimersByTime(10 * REPLY_TIMEOUT_MS)
      sockets[0]?.write(encodeReply({ id: 1, ok: true, result: { id: 'a.b', name: 'B' } }))
      expect(await link).toBe(0)

      // Unlink waits behind the installer's serial queue and the hosts' reload.
      const unlink = run(['plugin', 'unlink', 'a.b'], env(), Readable.from([]), io().io, '/w')
      await until(() => received.length === 2 && sockets.length === 2)
      vi.advanceTimersByTime(10 * REPLY_TIMEOUT_MS)
      sockets[1]?.write(encodeReply({ id: 1, ok: true, result: null }))
      expect(await unlink).toBe(0)

      const o = io()
      const list = run(['plugin', 'list'], env(), Readable.from([]), o.io, '/w')
      await until(() => received.length === 3 && sockets.length === 3)
      vi.advanceTimersByTime(REPLY_TIMEOUT_MS + 1)
      expect(await list).toBe(1)
      expect(o.e).toContain('did not answer')
    } finally {
      vi.useRealTimers()
    }
  })

  it('unlink and list: requests, text and JSON output', async () => {
    const o = io()
    expect(await run(['plugin', 'unlink', 'acme.todo'], env(), Readable.from([]), o.io, '/w')).toBe(0)
    expect(received[0]).toMatchObject({ cmd: 'plugin.unlink', args: { id: 'acme.todo' } })
    expect(o.o).toBe('unlinked acme.todo\n')

    const rows = [
      { id: 'acme.todo', name: 'Todo', version: '1.0.0', source: 'linked', enabled: true, state: 'ok' },
      { id: 'acme.bad', version: '0.1.0', source: 'git', enabled: false, state: 'invalid\nplugin' }
    ]
    answer = () => ({ ok: true, result: rows })
    const t = io()
    expect(await run(['plugin', 'list'], env(), Readable.from([]), t.io, '/w')).toBe(0)
    expect(t.o).toBe('acme.todo\t1.0.0\tlinked\tenabled\tok\nacme.bad\t0.1.0\tgit\tdisabled\tinvalid plugin\n')
    const j = io()
    expect(await run(['plugin', 'list', '--json'], env(), Readable.from([]), j.io, '/w')).toBe(0)
    expect(JSON.parse(j.o)).toEqual(rows)
  })

  it('outside a tab it needs --project (resolved against the cwd); with no app it is a silent exit 0', async () => {
    const noTab = { CC_COCKPIT_SOCK: sock }
    const o = io()
    expect(await run(['plugin', 'list'], noTab, Readable.from([]), o.io, '/w')).toBe(2)
    expect(o.e).toContain('needs --project')
    expect(received).toEqual([])
    expect(await run(['plugin', 'list', '--project', 'proj'], noTab, Readable.from([]), io().io, '/w')).toBe(0)
    expect(received[0]).toMatchObject({ cmd: 'plugin.list', project: '/w/proj' })
    expect(received[0]?.token).toBeUndefined()

    const gone = io()
    expect(await run(['plugin', 'list'], env({ CC_COCKPIT_SOCK: join(root, 'none.sock') }), Readable.from([]), gone.io, '/w')).toBe(0)
    expect(gone).toMatchObject({ o: '', e: '' })
  })

  it('buildRequest names the command per kind', () => {
    expect(buildRequest({ kind: 'plugin-unlink', id: 'a.b' }, { APP_TAB_TOKEN: TOKEN }, '/w')).toMatchObject({ cmd: 'plugin.unlink' })
    expect(buildRequest({ kind: 'plugin-link', dir: 'x' }, {}, '/w')).toEqual({ error: expect.stringContaining('--project') })
  })
})
