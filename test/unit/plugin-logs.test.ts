// `ccc plugin logs` (plan B Task 6): reads <data>/logs/<id>.log locally; the id is checked before
// it becomes a path; --follow tails appended lines and ends cleanly on the abort signal.
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { run } from '../../src/cli/client'
import { LOG_TAIL_LINES, pluginLogFile, runPluginLogs } from '../../src/cli/plugin-logs'

// The real open, wrapped so a test can make one open fail the way a rotation does.
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  return { ...real, open: vi.fn(real.open) }
})

/** The next open finds no file, as in the instant between plugin-log.ts's rename and its next write. */
function missingOnce(): void {
  vi.mocked(open).mockImplementationOnce(async () => {
    throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
  })
}

/** chmod does not stop root, so the EACCES tests cannot run as root. */
const asRoot = process.getuid?.() === 0

let data: string
let logs: string
beforeEach(() => {
  data = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-plugin-logs-')))
  logs = join(data, 'logs')
  mkdirSync(logs)
})
afterEach(() => {
  rmSync(data, { recursive: true, force: true })
})

const capture = (): { out: { stdout: (t: string) => void; stderr: (t: string) => void }; o: () => string; e: () => string } => {
  let o = ''
  let e = ''
  return { out: { stdout: (t) => void (o += t), stderr: (t) => void (e += t) }, o: () => o, e: () => e }
}

const until = async (check: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('pluginLogFile', () => {
  it('maps a plugin id into the logs folder and refuses anything path-like', () => {
    expect(pluginLogFile('/l', 'acme.todo')).toBe('/l/acme.todo.log')
    for (const bad of ['../x', 'a.b/../c', '/etc/passwd', 'a.b\0', '', 'nodot', 'A.B', `a.${'b'.repeat(120)}`]) {
      expect(pluginLogFile('/l', bad), bad).toBeUndefined()
    }
  })
})

describe('runPluginLogs', () => {
  it('prints the last lines of the log', async () => {
    const lines = Array.from({ length: LOG_TAIL_LINES + 50 }, (_, i) => `line ${i}`)
    writeFileSync(join(logs, 'acme.todo.log'), `${lines.join('\n')}\n`)
    const c = capture()
    expect(await runPluginLogs(logs, 'acme.todo', false, c.out)).toBe(0)
    const printed = c.o().trimEnd().split('\n')
    expect(printed).toHaveLength(LOG_TAIL_LINES)
    expect(printed[0]).toBe('line 50')
    expect(printed.at(-1)).toBe(`line ${LOG_TAIL_LINES + 49}`)
  })

  it('reads the end of a log far larger than the read window, starting on a whole line', async () => {
    const big = Array.from({ length: 20_000 }, (_, i) => `2026-10-31T00:00:00.000Z info [p1] entry number ${i}`).join('\n')
    writeFileSync(join(logs, 'acme.big.log'), `${big}\n`)
    const c = capture()
    expect(await runPluginLogs(logs, 'acme.big', false, c.out)).toBe(0)
    const printed = c.o().trimEnd().split('\n')
    expect(printed).toHaveLength(LOG_TAIL_LINES)
    expect(printed.every((l) => l.startsWith('2026-10-31'))).toBe(true)
    expect(printed.at(-1)).toContain('entry number 19999')
  })

  it('no log yet is exit 1 with a reason; a path-like id is refused before any file is touched', async () => {
    const c = capture()
    expect(await runPluginLogs(logs, 'acme.none', false, c.out)).toBe(1)
    expect(c.e()).toContain('no log for acme.none')
    const d = capture()
    expect(await runPluginLogs(logs, '../secret', false, d.out)).toBe(2)
    expect(d.e()).toContain('not a plugin id')
  })

  it('--follow prints appended lines, survives a rotation, and ends cleanly on abort', async () => {
    const file = join(logs, 'acme.todo.log')
    writeFileSync(file, 'old line\n')
    const c = capture()
    const abort = new AbortController()
    const done = runPluginLogs(logs, 'acme.todo', true, c.out, abort.signal, 10)
    await until(() => c.o() === 'old line\n')
    appendFileSync(file, 'second\n')
    await until(() => c.o().endsWith('second\n'))
    // plugin-log.ts rotates by renaming the file away and starting a new, smaller one.
    renameSync(file, `${file}.1`)
    writeFileSync(file, 'n\n')
    await until(() => c.o().endsWith('second\nn\n'))
    abort.abort()
    expect(await done).toBe(0)
    expect(c.e()).toBe('')
  })

  it('--follow on a plugin that has not logged yet waits for the file', async () => {
    const c = capture()
    const abort = new AbortController()
    const done = runPluginLogs(logs, 'acme.later', true, c.out, abort.signal, 10)
    await new Promise((r) => setTimeout(r, 40))
    writeFileSync(join(logs, 'acme.later.log'), 'hello\n')
    await until(() => c.o() === 'hello\n')
    abort.abort()
    expect(await done).toBe(0)
  })

  it('an already aborted follow ends at once', async () => {
    writeFileSync(join(logs, 'acme.todo.log'), 'a\n')
    const abort = new AbortController()
    abort.abort()
    const c = capture()
    expect(await runPluginLogs(logs, 'acme.todo', true, c.out, abort.signal, 10)).toBe(0)
    expect(c.o()).toBe('a\n')
  })
})

describe('runPluginLogs read errors (review finding: they escaped as a silent exit 0)', () => {
  it.skipIf(asRoot)('an unreadable log is exit 1 with the reason, plain and --follow', async () => {
    const file = join(logs, 'acme.todo.log')
    writeFileSync(file, 'secret\n')
    chmodSync(file, 0o000)
    const c = capture()
    expect(await runPluginLogs(logs, 'acme.todo', false, c.out)).toBe(1)
    expect(c.e()).toMatch(/^ccc: cannot read the log of acme\.todo: EACCES/)
    expect(c.o()).toBe('')
    const f = capture()
    // No abort signal: it must end by itself, not poll an unreadable file forever.
    expect(await runPluginLogs(logs, 'acme.todo', true, f.out, undefined, 10)).toBe(1)
    expect(f.e()).toMatch(/^ccc: cannot read the log of acme\.todo: EACCES/)
  })

  it.skipIf(asRoot)('a log that becomes unreadable while followed ends --follow with exit 1', async () => {
    const file = join(logs, 'acme.todo.log')
    writeFileSync(file, 'a\n')
    const c = capture()
    const done = runPluginLogs(logs, 'acme.todo', true, c.out, undefined, 10)
    await until(() => c.o() === 'a\n')
    chmodSync(file, 0o000)
    expect(await done).toBe(1)
    expect(c.e()).toMatch(/cannot read the log of acme\.todo: EACCES/)
  })

  it.skipIf(asRoot)('through the client too: exit 1, not 0', async () => {
    const file = join(logs, 'acme.todo.log')
    writeFileSync(file, 'x\n')
    chmodSync(file, 0o000)
    const c = capture()
    const code = await run(['plugin', 'logs', 'acme.todo'], { CC_COCKPIT_DATA_DIR: data, CC_COCKPIT_SOCK: '/nonexistent/sock' }, Readable.from([]), c.out)
    expect(code).toBe(1)
    expect(c.e()).toContain('cannot read the log of acme.todo')
  })

  it('a log missing for an instant (mid-rotation) is read on the next look, plain and --follow', async () => {
    writeFileSync(join(logs, 'acme.todo.log'), 'after rotation\n')
    missingOnce()
    const c = capture()
    expect(await runPluginLogs(logs, 'acme.todo', false, c.out)).toBe(0)
    expect(c.o()).toBe('after rotation\n')
    expect(c.e()).toBe('')
    // --follow: the first open misses, and following goes on instead of ending.
    missingOnce()
    const f = capture()
    const abort = new AbortController()
    const done = runPluginLogs(logs, 'acme.todo', true, f.out, abort.signal, 10)
    await until(() => f.o() === 'after rotation\n')
    missingOnce() // and a miss while following
    appendFileSync(join(logs, 'acme.todo.log'), 'more\n')
    await until(() => f.o().endsWith('more\n'))
    abort.abort()
    expect(await done).toBe(0)
    expect(f.o()).toBe('after rotation\nmore\n')
    expect(f.e()).toBe('')
  })
})

describe('ccc plugin logs through the client', () => {
  it('uses the data dir of the environment, with no app', async () => {
    writeFileSync(join(logs, 'acme.todo.log'), 'from the file\n')
    const c = capture()
    const code = await run(['plugin', 'logs', 'acme.todo'], { CC_COCKPIT_DATA_DIR: data, CC_COCKPIT_SOCK: '/nonexistent/sock' }, Readable.from([]), c.out)
    expect(code).toBe(0)
    expect(c.o()).toBe('from the file\n')
  })
})
