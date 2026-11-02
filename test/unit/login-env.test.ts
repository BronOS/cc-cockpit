import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  LOGIN_ENV_COMMAND,
  LOGIN_ENV_MAX_BYTES,
  defaultSpawner,
  loadLoginEnv,
  parseEnvZ,
  parseLoginEnvOutput,
  type Spawner
} from '../../src/main/env/login-env'

// What LOGIN_ENV_COMMAND prints around the `env -0` output.
const BEGIN = '\0__CCC_ENV_BEGIN__\0'
const END = '__CCC_ENV_END__\0'

describe('parseEnvZ', () => {
  it('splits on NUL and keeps newlines and = inside values', () => {
    const out = parseEnvZ('A=1\0MULTI=line1\nline2\0EQ=a=b=c\0EMPTY=\0')
    expect(out).toEqual({ A: '1', MULTI: 'line1\nline2', EQ: 'a=b=c', EMPTY: '' })
  })

  it('skips records without a name or without =', () => {
    expect(parseEnvZ('noise\0=x\0OK=1')).toEqual({ OK: '1' })
  })

  it('skips records whose name is not a portable env name', () => {
    expect(parseEnvZ('Welcome\nPATH=/x\0\x1b[0mA=1\x001X=2\0A-B=3\0_ok9=4')).toEqual({ _ok9: '4' })
  })
})

describe('parseLoginEnvOutput', () => {
  it('ignores rc noise before BEGIN and .zlogout noise after END', () => {
    const stdout = `\x1b]1337;p10k\x07Last login: today\nWelcome${BEGIN}PATH=/opt/bin\0HOME=/h\0${END}bye=see you\0X=1`
    expect(parseLoginEnvOutput(stdout)).toEqual({ PATH: '/opt/bin', HOME: '/h' })
  })

  it('returns null when a marker is missing (command did not run, or output truncated)', () => {
    expect(parseLoginEnvOutput('PATH=/x\0')).toBeNull()
    expect(parseLoginEnvOutput(`${BEGIN}PATH=/x\0`)).toBeNull()
    expect(parseLoginEnvOutput(`${END}${BEGIN}PATH=/x\0`)).toBeNull()
  })
})

describe('loadLoginEnv', () => {
  const base = { SHELL: '/bin/zsh', PATH: '/usr/bin' }

  it('runs the fixed login command as argv and returns the parsed env', async () => {
    const spawner = vi.fn<Spawner>().mockResolvedValue({ code: 0, stdout: `noise${BEGIN}PATH=/opt/bin\0X=y\0${END}` })
    const env = await loadLoginEnv(base, { spawner, log: vi.fn() })
    expect(spawner).toHaveBeenCalledWith(['/bin/zsh', '-l', '-i', '-c', LOGIN_ENV_COMMAND], {
      timeoutMs: 5000,
      maxBytes: LOGIN_ENV_MAX_BYTES
    })
    expect(env).toEqual({ PATH: '/opt/bin', X: 'y' })
  })

  it('the command string is fixed and prints the markers around env -0', () => {
    expect(LOGIN_ENV_COMMAND).toBe("printf '\\0__CCC_ENV_BEGIN__\\0'; env -0; printf '__CCC_ENV_END__\\0'")
  })

  it('passes an injected timeout to the spawner', async () => {
    const spawner = vi.fn<Spawner>().mockResolvedValue({ code: 0, stdout: `${BEGIN}A=1\0${END}` })
    await loadLoginEnv(base, { spawner, log: vi.fn(), timeoutMs: 50 })
    expect(spawner.mock.calls[0]?.[1]).toEqual({ timeoutMs: 50, maxBytes: LOGIN_ENV_MAX_BYTES })
  })

  it('falls back to the base env when the spawner times out', async () => {
    const log = vi.fn()
    const spawner: Spawner = () => Promise.reject(new Error('timed out after 5000 ms'))
    const env = await loadLoginEnv(base, { spawner, log })
    expect(env).toEqual(base)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('timed out'))
  })

  it('falls back on a non-zero exit', async () => {
    const log = vi.fn()
    const spawner: Spawner = () => Promise.resolve({ code: 1, stdout: `${BEGIN}PATH=/x\0${END}` })
    expect(await loadLoginEnv(base, { spawner, log })).toEqual(base)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('code 1'))
  })

  it('falls back when the output is truncated before the END marker', async () => {
    const log = vi.fn()
    const spawner: Spawner = () => Promise.resolve({ code: 0, stdout: `${BEGIN}PATH=/x\0` })
    expect(await loadLoginEnv(base, { spawner, log })).toEqual(base)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('markers'))
  })

  it('falls back on empty output and when SHELL is unset (no spawn)', async () => {
    const spawner = vi.fn<Spawner>().mockResolvedValue({ code: 0, stdout: '' })
    expect(await loadLoginEnv(base, { spawner, log: vi.fn() })).toEqual(base)
    spawner.mockResolvedValue({ code: 0, stdout: `${BEGIN}${END}` })
    expect(await loadLoginEnv(base, { spawner, log: vi.fn() })).toEqual(base)
    spawner.mockClear()
    expect(await loadLoginEnv({ PATH: '/usr/bin' }, { spawner, log: vi.fn() })).toEqual({ PATH: '/usr/bin' })
    expect(spawner).not.toHaveBeenCalled()
  })
})

// The real spawner, run against `node -e <script>` instead of a login shell. Scripts take a pid
// file path as their only argument so a test can find (and check or clean up) a grandchild.
describe('defaultSpawner', () => {
  const node = process.execPath
  const opts = { timeoutMs: 3000, maxBytes: LOGIN_ENV_MAX_BYTES }
  // Starts a long-lived grandchild that inherits stdout (like `ssh-agent &` in .zshrc) and
  // records its pid.
  const startGrandchild =
    "const g = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], " +
    "{ stdio: ['ignore', 'inherit', 'ignore'] }); require('fs').writeFileSync(process.argv[1], String(g.pid)); g.unref();"

  let dir: string
  let pidFile: string

  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  const readPid = async (): Promise<number> => {
    for (let i = 0; i < 100 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 20))
    return Number(readFileSync(pidFile, 'utf8'))
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ccc-login-env-'))
    pidFile = join(dir, 'grandchild.pid')
  })

  afterEach(() => {
    if (existsSync(pidFile)) {
      try {
        process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL')
      } catch {
        // already gone
      }
    }
    rmSync(dir, { recursive: true, force: true })
  })

  it('resolves with the exit code and stdout', async () => {
    const res = await defaultSpawner([node, '-e', "process.stdout.write('A=1\\0'); process.exitCode = 3"], opts)
    expect(res).toEqual({ code: 3, stdout: 'A=1\0' })
  })

  it('rejects on a spawn error (ENOENT)', async () => {
    await expect(defaultSpawner([join(dir, 'no-such-shell')], opts)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('kills the child and rejects when stdout exceeds the cap', async () => {
    const script = "process.stdout.write('x'.repeat(5000)); setInterval(() => {}, 1000)"
    await expect(defaultSpawner([node, '-e', script], { timeoutMs: 3000, maxBytes: 1000 })).rejects.toThrow(
      'output exceeded 1000 bytes'
    )
  })

  it('resolves soon after exit even when a background grandchild keeps stdout open', async () => {
    const script = `${startGrandchild} process.stdout.write('A=1\\0')`
    const started = Date.now()
    const res = await defaultSpawner([node, '-e', script, pidFile], opts)
    expect(res).toEqual({ code: 0, stdout: 'A=1\0' })
    expect(Date.now() - started).toBeLessThan(2000)
    // The grandchild belongs to the user's rc files; a normal exit does not kill it.
    expect(alive(await readPid())).toBe(true)
  })

  it('on timeout kills the whole process group, grandchildren included', async () => {
    const script = `${startGrandchild} setInterval(() => {}, 1000)`
    await expect(defaultSpawner([node, '-e', script, pidFile], { ...opts, timeoutMs: 1000 })).rejects.toThrow(
      'timed out after 1000 ms'
    )
    const pid = await readPid()
    // SIGKILL is async and launchd must reap the orphan; poll briefly.
    for (let i = 0; i < 100 && alive(pid); i++) await new Promise((r) => setTimeout(r, 20))
    expect(alive(pid)).toBe(false)
  })
})
