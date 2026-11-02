import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PluginLogWriter } from '../../src/main/plugins/plugin-log'

describe('PluginLogWriter', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ccc-plog-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  const entry = (text: string, pluginId = 'a.one') => ({ pluginId, projectId: 'p1', level: 'info', text })

  it('appends timestamped lines to <logs>/<pluginId>.log, creating the directory', () => {
    const dir = join(root, 'logs')
    const w = new PluginLogWriter({ dir, now: () => Date.UTC(2026, 9, 29, 12, 0, 0) })
    w.write(entry('first'))
    w.write({ ...entry('second'), level: 'error' })
    expect(readFileSync(join(dir, 'a.one.log'), 'utf8')).toBe(
      '2026-10-29T12:00:00.000Z info [p1] first\n2026-10-29T12:00:00.000Z error [p1] second\n'
    )
    expect(statSync(join(dir, 'a.one.log')).mode & 0o777).toBe(0o600)
  })

  it('keeps each plugin in its own file', () => {
    const w = new PluginLogWriter({ dir: root })
    w.write(entry('x', 'a.one'))
    w.write(entry('y', 'b.two'))
    expect(readdirSync(root).sort()).toEqual(['a.one.log', 'b.two.log'])
  })

  it('rotates at the size limit: the old file becomes .log.1, replacing an older one', () => {
    const w = new PluginLogWriter({ dir: root, maxBytes: 200, now: () => 0 })
    const line = 'x'.repeat(60)
    for (let i = 0; i < 12; i++) w.write(entry(`${i} ${line}`))
    const files = readdirSync(root).sort()
    expect(files).toEqual(['a.one.log', 'a.one.log.1'])
    expect(statSync(join(root, 'a.one.log')).size).toBeLessThanOrEqual(200)
    expect(statSync(join(root, 'a.one.log.1')).size).toBeLessThanOrEqual(200)
    // The newest line is in the current file; nothing is lost between the two but the oldest.
    expect(readFileSync(join(root, 'a.one.log'), 'utf8')).toContain(`11 ${line}`)
  })

  it('continues the size count of a file that already exists', () => {
    const first = new PluginLogWriter({ dir: root, maxBytes: 150, now: () => 0 })
    first.write(entry('a'.repeat(80)))
    const second = new PluginLogWriter({ dir: root, maxBytes: 150, now: () => 0 })
    second.write(entry('b'.repeat(80)))
    expect(existsSync(join(root, 'a.one.log.1'))).toBe(true)
  })

  it('refuses a plugin id that is not a safe file name, and never throws', () => {
    const log = vi.fn()
    const w = new PluginLogWriter({ dir: join(root, 'logs'), log })
    w.write(entry('x', '../../evil'))
    w.write(entry('x', 'no-dot'))
    w.write(entry('x', 'a/b.c'))
    expect(existsSync(join(root, 'logs'))).toBe(false)
    expect(log).toHaveBeenCalledTimes(3)
  })

  it('logs a write failure instead of throwing, and retries from the real size next time', () => {
    const log = vi.fn()
    let fail = true
    const fs = {
      mkdirSync: () => undefined,
      statSync: () => ({ size: 0 }),
      renameSync: () => undefined,
      appendFileSync: () => {
        if (fail) throw new Error('ENOSPC')
      }
    }
    const w = new PluginLogWriter({ dir: root, fs, log })
    expect(() => w.write(entry('x'))).not.toThrow()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('ENOSPC'))
    fail = false
    expect(() => w.write(entry('y'))).not.toThrow()
  })
})
