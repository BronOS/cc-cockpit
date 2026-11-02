// ctx.exec runs REAL child processes (this Node, and a tiny sh script for the PATH lookup): the
// point of the feature is what the OS does with argv, stdin and signals, which a fake spawn would
// not show. Everything happens in temp dirs.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HostContexts } from '../../src/host/ctx'
import { runExec, type ExecContext } from '../../src/host/ctx/exec'
import { hostSpec } from '../fakes/host-spec'

const node = process.execPath

describe('ctx.exec', () => {
  let root: string
  let ctx: ExecContext
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-exec-')))
    ctx = { projectDir: root, env: { PATH: process.env.PATH } }
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('returns the exit code, stdout and stderr', async () => {
    const r = await runExec([node, '-e', 'console.log("out"); console.error("err"); process.exit(3)'], {}, ctx)
    expect(r).toEqual({ code: 3, stdout: 'out\n', stderr: 'err\n' })
  })

  it('keeps shell metacharacters literal: each argv item arrives as one argument', async () => {
    const nasty = ['$(touch pwned)', '`touch pwned`', '; touch pwned', '| cat', '"quoted" \'single\'', '*', '~', 'a b  c', '--', '-n', '\n']
    const r = await runExec([node, '-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...nasty], {}, ctx)
    expect(JSON.parse(r.stdout)).toEqual(nasty)
    // Nothing was run by a shell: the file the payloads would create does not exist.
    await expect(runExec(['test', '-e', 'pwned'], {}, ctx)).resolves.toMatchObject({ code: 1 })
  })

  it('writes stdin and closes it, so a program reading to EOF finishes', async () => {
    const script = 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(d.toUpperCase()))'
    const r = await runExec([node, '-e', script], { stdin: 'héllo $(x)\nworld' }, ctx)
    expect(r).toMatchObject({ code: 0, stdout: 'HÉLLO $(X)\nWORLD' })
    // No stdin given: still closed (EOF at once), not left open.
    const none = await runExec([node, '-e', script], {}, ctx)
    expect(none).toMatchObject({ code: 0, stdout: '' })
  })

  it('does not fail when the child exits without reading a large stdin', async () => {
    const r = await runExec([node, '-e', 'process.exit(0)'], { stdin: 'x'.repeat(5 * 1024 * 1024) }, ctx)
    expect(r.code).toBe(0)
  })

  it('looks argv[0] up on the PATH of the env it was given, not on a fixed list', async () => {
    const bin = join(root, 'bin')
    const tool = join(bin, 'cc-fake-tool')
    mkdirSync(bin)
    writeFileSync(tool, '#!/bin/sh\necho "found $1"\n')
    chmodSync(tool, 0o755)
    const r = await runExec(['cc-fake-tool', 'arg'], {}, { ...ctx, env: { PATH: bin } })
    expect(r).toMatchObject({ code: 0, stdout: 'found arg\n' })
    await expect(runExec(['cc-fake-tool'], {}, ctx)).rejects.toThrow('cannot run cc-fake-tool')
  })

  it('passes the env it was given and nothing else', async () => {
    const r = await runExec([node, '-e', 'process.stdout.write(JSON.stringify(Object.keys(process.env).sort()))'], {}, {
      ...ctx,
      env: { PATH: process.env.PATH, ONLY_THIS: '1' }
    })
    expect(JSON.parse(r.stdout)).toEqual(expect.arrayContaining(['ONLY_THIS', 'PATH']))
    expect(JSON.parse(r.stdout)).not.toContain('HOME')
  })

  it('defaults cwd to the project folder; a relative cwd is relative to it; others must exist', async () => {
    const show = [node, '-e', 'process.stdout.write(process.cwd())']
    expect((await runExec(show, {}, ctx)).stdout).toBe(root)
    const sub = join(root, 'sub')
    mkdirSync(sub)
    expect((await runExec(show, { cwd: 'sub' }, ctx)).stdout).toBe(sub)
    const other = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-exec-other-')))
    try {
      expect((await runExec(show, { cwd: other }, ctx)).stdout).toBe(other)
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
    await expect(runExec(show, { cwd: join(root, 'nope') }, ctx)).rejects.toThrow('not an existing directory')
    writeFileSync(join(root, 'afile'), '')
    await expect(runExec(show, { cwd: 'afile' }, ctx)).rejects.toThrow('not an existing directory')
  })

  it('rejects when the program does not exist', async () => {
    await expect(runExec(['cc-no-such-program-xyz'], {}, ctx)).rejects.toThrow('cannot run cc-no-such-program-xyz')
  })

  it('kills the child and rejects when the output passes the cap, stdout and stderr counted together', async () => {
    const small = { ...ctx, maxOutputBytes: 1000 }
    await expect(
      runExec([node, '-e', 'process.stdout.write("x".repeat(5000)); setInterval(()=>{},1000)'], {}, small)
    ).rejects.toThrow('more than 1000 bytes of output')
    // 600 + 600 across the two streams is over a 1000-byte cap although neither alone is.
    await expect(
      runExec([node, '-e', 'process.stdout.write("x".repeat(600)); process.stderr.write("y".repeat(600)); setInterval(()=>{},1000)'], {}, small)
    ).rejects.toThrow('more than 1000 bytes')
    // Exactly at the cap is fine.
    const r = await runExec([node, '-e', 'process.stdout.write("x".repeat(1000))'], {}, small)
    expect(r.stdout).toHaveLength(1000)
  })

  it('does not split a multi-byte character that arrives in two chunks', async () => {
    const script = 'const b=Buffer.from("€");process.stdout.write(b.subarray(0,1));setTimeout(()=>process.stdout.write(b.subarray(1)),50)'
    expect((await runExec([node, '-e', script], {}, ctx)).stdout).toBe('€')
  })

  it('kills the child on timeout and resolves with code null and what it wrote', async () => {
    const started = Date.now()
    // 2 s: the child must start Node and print before the kill; a loaded machine (the full suite
    // runs in parallel) can take well over the few hundred ms that takes when idle.
    const r = await runExec([node, '-e', 'console.log("started"); setInterval(()=>{},1000)'], { timeoutMs: 2000 }, ctx)
    expect(r.code).toBeNull()
    expect(r.stdout).toBe('started\n')
    expect(Date.now() - started).toBeLessThan(10_000)
  }, 15_000)

  it.skipIf(process.platform === 'win32')('kills the whole process group on timeout, so grandchildren do not survive', async () => {
    const pidFile = join(root, 'grandchild.pid')
    const script = `
      const { spawn } = require('node:child_process');
      const g = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
      require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));
      setInterval(()=>{},1000)`
    // 2 s: the child must start Node, spawn the grandchild and write its pid before the kill.
    const r = await runExec([node, '-e', script], { timeoutMs: 2000 }, ctx)
    expect(r.code).toBeNull()
    // Polled (as login-env's readPid) rather than read at once, which could race the write.
    for (let i = 0; i < 100 && !existsSync(pidFile); i++) await new Promise((r2) => setTimeout(r2, 20))
    const pid = Number(readFileSync(pidFile, 'utf8'))
    // 0 (an empty file) would make kill(0, 0) probe our own process group and always pass.
    expect(pid).toBeGreaterThan(0)
    const alive = (): boolean => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    for (let i = 0; i < 50 && alive(); i++) await new Promise((r2) => setTimeout(r2, 50))
    expect(alive()).toBe(false)
  }, 15_000)

  it.skipIf(process.platform === 'win32')('a background process holding the pipes open does not hang the call past its timeout', async () => {
    // sh exits at once (code 0); the backgrounded sleep keeps stdout open. The call still timed
    // out, so the code is null: sh's 0 next to possibly cut-off output would hide that.
    const r = await runExec(['sh', '-c', 'echo hi; sleep 30 &'], { timeoutMs: 500 }, ctx)
    expect(r).toMatchObject({ code: null, stdout: 'hi\n' })
  })

  it('validates argv and options', async () => {
    await expect(runExec([], {}, ctx)).rejects.toThrow('non-empty array')
    await expect(runExec('ls' as unknown as string[], {}, ctx)).rejects.toThrow('non-empty array')
    await expect(runExec([''], {}, ctx)).rejects.toThrow('argv[0] must not be empty')
    await expect(runExec(['ls', 5 as unknown as string], {}, ctx)).rejects.toThrow('must be a string')
    await expect(runExec(['ls', 'a\0b'], {}, ctx)).rejects.toThrow('NUL')
    await expect(runExec(['ls'], { stdin: 5 as unknown as string }, ctx)).rejects.toThrow('stdin must be a string')
    await expect(runExec(['ls'], { cwd: '' }, ctx)).rejects.toThrow('cwd')
    await expect(runExec(['ls'], { timeoutMs: -1 }, ctx)).rejects.toThrow('timeoutMs')
    await expect(runExec(['ls'], { timeoutMs: Number.NaN }, ctx)).rejects.toThrow('timeoutMs')
  })

  it('kills running children when the plugin is deactivated', async () => {
    const contexts = new HostContexts({ log: () => {}, env: { PATH: process.env.PATH } })
    const c = contexts.create(hostSpec({ id: 'a.one', dir: root, main: 'm.js' }))
    const pending = c.exec([node, '-e', 'setInterval(()=>{},1000)'])
    await new Promise((r) => setTimeout(r, 300))
    contexts.dispose('a.one')
    // Killed by the group SIGKILL: resolves with a null code instead of running for the full 60 s.
    await expect(pending).resolves.toMatchObject({ code: null })
    await expect(c.exec([node, '-e', '0'])).rejects.toThrow('deactivated')
  })

  it('spawns nothing when the plugin is deactivated while the cwd is being checked', async () => {
    // runExec awaits a stat of the cwd before spawning; a child spawned after dispose would be
    // detached and missing from the set dispose already emptied, so it would outlive the host.
    let disposed = false
    let spawned = 0
    const pending = runExec([node, '-e', '0'], {}, {
      ...ctx,
      alive: () => {
        if (disposed) throw new Error('the plugin is deactivated')
      },
      spawnFn: () => {
        spawned++
        throw new Error('must not spawn')
      }
    })
    disposed = true
    await expect(pending).rejects.toThrow('deactivated')
    expect(spawned).toBe(0)

    // The same through the plugin's ctx: dispose lands during the stat.
    const contexts = new HostContexts({ log: () => {}, env: { PATH: process.env.PATH } })
    const c = contexts.create(hostSpec({ id: 'a.one', dir: root, main: 'm.js' }))
    const marker = join(root, 'ran')
    const viaCtx = c.exec([node, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, '')`])
    contexts.dispose('a.one')
    await expect(viaCtx).rejects.toThrow('deactivated')
    await new Promise((r) => setTimeout(r, 300))
    expect(existsSync(marker)).toBe(false)
  })

  it('killChildrenAndFlush kills running children and flushes storage, and leaves the plugin usable', async () => {
    const storageFile = join(root, 'data', 'storage.json')
    // A long debounce: only the explicit flush can have written the file.
    const contexts = new HostContexts({ log: () => {}, env: { PATH: process.env.PATH }, storageDebounceMs: 60_000 })
    const c = contexts.create(hostSpec({ id: 'a.one', dir: root, main: 'm.js', storageFile }))
    await c.storage.set('k', 'v')
    const pending = c.exec([node, '-e', 'setInterval(()=>{},1000)'])
    await new Promise((r) => setTimeout(r, 300))
    contexts.killChildrenAndFlush()
    await expect(pending).resolves.toMatchObject({ code: null })
    expect(JSON.parse(readFileSync(storageFile, 'utf8')).values).toEqual({ k: 'v' })
    // Not disposed: the plugin's deactivate() runs after this and may still use its ctx.
    await expect(c.storage.set('k2', 1)).resolves.toBeUndefined()
    await expect(c.exec([node, '-e', 'process.exit(4)'])).resolves.toMatchObject({ code: 4 })
    contexts.dispose('a.one')
    expect(JSON.parse(readFileSync(storageFile, 'utf8')).values).toEqual({ k: 'v', k2: 1 })
  })
})
