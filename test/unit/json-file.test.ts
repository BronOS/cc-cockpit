import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as nodeFs from 'node:fs'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonFile, type FsOps, type Versioned } from '../../src/main/store/json-file'

interface Doc extends Versioned {
  name: string
  count: number
}

const defaults = (): Doc => ({ schemaVersion: 1, name: 'default', count: 0 })

let dir: string
let file: string
let logs: string[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ccc-json-'))
  file = join(dir, 'doc.json')
  logs = []
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

function open(extra: Partial<ConstructorParameters<typeof JsonFile<Doc>>[0]> = {}): JsonFile<Doc> {
  return new JsonFile<Doc>({ filePath: file, defaults, log: (m) => logs.push(m), ...extra })
}

const onDisk = (): unknown => JSON.parse(readFileSync(file, 'utf8'))

describe('JsonFile load', () => {
  it('returns defaults when the file does not exist, without creating it', () => {
    const f = open()
    expect(f.data).toEqual(defaults())
    expect(nodeFs.existsSync(file)).toBe(false)
    expect(f.readOnly).toBe(false)
  })

  it('loads a saved file and fills in keys added since', () => {
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, name: 'saved' }))
    expect(open().data).toEqual({ schemaVersion: 1, name: 'saved', count: 0 })
  })

  it('loads defaults from corrupt JSON and keeps a .corrupt-<ts> copy', () => {
    writeFileSync(file, '{ not json')
    const f = open({ now: () => 12345 })
    expect(f.data).toEqual(defaults())
    expect(readFileSync(`${file}.corrupt-12345`, 'utf8')).toBe('{ not json')
    expect(logs.join('\n')).toContain('unusable')
    // Corrupt is recoverable: the next save replaces the broken file.
    expect(f.readOnly).toBe(false)
  })

  it('treats a non-object and a missing schemaVersion as corrupt', () => {
    writeFileSync(file, '[1,2]')
    expect(open({ now: () => 1 }).data).toEqual(defaults())
    expect(nodeFs.existsSync(`${file}.corrupt-1`)).toBe(true)

    writeFileSync(file, JSON.stringify({ name: 'x' }))
    expect(open({ now: () => 2 }).data).toEqual(defaults())
    expect(nodeFs.existsSync(`${file}.corrupt-2`)).toBe(true)
  })

  it('does not overwrite a file with a future schemaVersion', () => {
    const future = JSON.stringify({ schemaVersion: 2, name: 'from the future', extra: true })
    writeFileSync(file, future)
    const f = open()
    expect(f.readOnly).toBe(true)
    expect(f.data).toEqual(defaults())
    expect(logs.join('\n')).toContain('schemaVersion 2')

    f.update((d) => {
      d.count = 5
    })
    f.flush()
    expect(readFileSync(file, 'utf8')).toBe(future)
    expect(readdirSync(dir)).toEqual(['doc.json'])
  })

  it('refuses to overwrite a file it cannot read', () => {
    // A directory at the path makes readFileSync fail with EISDIR, not ENOENT.
    nodeFs.mkdirSync(file)
    const f = open()
    expect(f.readOnly).toBe(true)
    expect(f.data).toEqual(defaults())
  })
})

describe('JsonFile quarantine failure', () => {
  it('goes read-only when the .corrupt copy cannot be made', () => {
    writeFileSync(file, '{ not json')
    const fs: FsOps = {
      ...nodeFs,
      copyFileSync: () => {
        throw new Error('ENOSPC')
      }
    }
    const f = open({ fs })
    expect(f.readOnly).toBe(true)
    f.save()
    f.flush()
    expect(readFileSync(file, 'utf8')).toBe('{ not json')
  })
})

describe('JsonFile save', () => {
  it('retries a failed timer-driven write without another save()', () => {
    vi.useFakeTimers()
    let fail = true
    const fs: FsOps = {
      ...nodeFs,
      fsyncSync: (fd) => {
        if (fail) throw new Error('ENOSPC')
        nodeFs.fsyncSync(fd)
      }
    }
    const f = open({ fs, debounceMs: 10 })
    f.update((d) => {
      d.name = 'retried'
    })
    vi.advanceTimersByTime(10)
    expect(nodeFs.existsSync(file)).toBe(false)
    fail = false
    vi.advanceTimersByTime(10)
    expect(onDisk()).toEqual({ schemaVersion: 1, name: 'retried', count: 0 })
  })

  it('writes atomically and pretty-prints with the schemaVersion', () => {
    const f = open()
    f.update((d) => {
      d.name = 'a'
    })
    f.flush()
    expect(onDisk()).toEqual({ schemaVersion: 1, name: 'a', count: 0 })
    expect(readFileSync(file, 'utf8').endsWith('}\n')).toBe(true)
    expect(readdirSync(dir)).toEqual(['doc.json'])
  })

  it('creates missing parent directories', () => {
    file = join(dir, 'deep', 'er', 'doc.json')
    const f = open()
    f.save()
    f.flush()
    expect(onDisk()).toEqual(defaults())
  })

  it('leaves the old file intact and no tmp file when the write throws', () => {
    const f = open()
    f.update((d) => {
      d.name = 'good'
    })
    f.flush()

    const failing: FsOps = {
      ...nodeFs,
      writeSync: () => {
        throw new Error('disk full')
      }
    }
    const g = open({ fs: failing })
    g.update((d) => {
      d.name = 'lost'
    })
    g.flush()

    expect(onDisk()).toEqual({ schemaVersion: 1, name: 'good', count: 0 })
    expect(readdirSync(dir)).toEqual(['doc.json'])
    expect(logs.join('\n')).toContain('disk full')
  })

  it('finishes a short write: keeps writing the rest until every byte is on disk', () => {
    const calls: number[] = []
    const fs: FsOps = {
      ...nodeFs,
      // At most 7 bytes per call, like a write(2) that returns early.
      writeSync: (fd, buffer, offset, length) => {
        const n = nodeFs.writeSync(fd, buffer, offset, Math.min(length, 7))
        calls.push(n)
        return n
      }
    }
    const f = open({ fs })
    f.update((d) => {
      d.name = 'a longer name than seven bytes'
    })
    f.flush()
    expect(calls.length).toBeGreaterThan(1)
    expect(onDisk()).toEqual({ schemaVersion: 1, name: 'a longer name than seven bytes', count: 0 })
    expect(f.pending).toBe(false)
  })

  it('never renames a partly written tmp file over the good one (a write that stops making progress)', () => {
    const first = open()
    first.update((d) => {
      d.name = 'good'
    })
    first.flush()
    let stalled = true
    const fs: FsOps = {
      ...nodeFs,
      // Writes 5 bytes, then nothing: the disk filled up mid-write.
      writeSync: (fd, buffer, offset, length) => {
        if (!stalled) return nodeFs.writeSync(fd, buffer, offset, length)
        return offset === 0 ? nodeFs.writeSync(fd, buffer, 0, 5) : 0
      }
    }
    const g = open({ fs })
    g.update((d) => {
      d.name = 'second'
    })
    g.flush()
    expect(onDisk()).toEqual({ schemaVersion: 1, name: 'good', count: 0 })
    expect(readdirSync(dir)).toEqual(['doc.json'])
    expect(g.pending).toBe(true)
    expect(logs.join('\n')).toContain('short write')

    stalled = false
    g.flush()
    expect(onDisk()).toEqual({ schemaVersion: 1, name: 'second', count: 0 })
  })

  it('leaves the old file intact when fsync throws, and retries on the next flush', () => {
    const first = open()
    first.update((d) => {
      d.name = 'good'
    })
    first.flush()
    let fail = true
    const fs: FsOps = {
      ...nodeFs,
      fsyncSync: (fd) => {
        if (fail) throw new Error('EIO')
        nodeFs.fsyncSync(fd)
      }
    }
    const g = open({ fs })
    g.data.name = 'second'
    g.save()
    g.flush()
    expect(onDisk()).toEqual({ schemaVersion: 1, name: 'good', count: 0 })

    fail = false
    g.flush()
    expect(onDisk()).toEqual({ schemaVersion: 1, name: 'second', count: 0 })
  })

  it('coalesces writes inside the debounce window into one', () => {
    vi.useFakeTimers()
    const writes: string[] = []
    const fs: FsOps = {
      ...nodeFs,
      renameSync: (a, b) => {
        writes.push(b)
        nodeFs.renameSync(a, b)
      }
    }
    const f = open({ fs })
    f.update((d) => {
      d.count = 1
    })
    vi.advanceTimersByTime(100)
    f.update((d) => {
      d.count = 2
    })
    vi.advanceTimersByTime(100)
    f.update((d) => {
      d.count = 3
    })
    expect(writes).toHaveLength(0)
    expect(nodeFs.existsSync(file)).toBe(false)

    // The window is fixed from the first change (300 ms), not extended by later ones.
    vi.advanceTimersByTime(100)
    expect(writes).toHaveLength(1)
    expect(onDisk()).toEqual({ schemaVersion: 1, name: 'default', count: 3 })

    // Nothing left to write.
    vi.advanceTimersByTime(1000)
    expect(writes).toHaveLength(1)
  })

  it('flush writes immediately and cancels the pending timer', () => {
    vi.useFakeTimers()
    let renames = 0
    const fs: FsOps = {
      ...nodeFs,
      renameSync: (a, b) => {
        renames++
        nodeFs.renameSync(a, b)
      }
    }
    const f = open({ fs })
    f.update((d) => {
      d.count = 9
    })
    f.flush()
    expect(onDisk()).toEqual({ schemaVersion: 1, name: 'default', count: 9 })
    vi.advanceTimersByTime(1000)
    expect(renames).toBe(1)
  })

  it('flush with nothing pending writes nothing', () => {
    const f = open()
    f.flush()
    expect(nodeFs.existsSync(file)).toBe(false)
  })

  it('stamps its own schemaVersion even if the caller changed it', () => {
    const f = open()
    f.data.schemaVersion = 99
    f.save()
    f.flush()
    expect((onDisk() as Doc).schemaVersion).toBe(1)
  })
})
