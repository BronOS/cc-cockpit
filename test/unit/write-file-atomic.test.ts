// writeFileAtomic writes hooks.json and the generated bin/ccc: the exact mode (an executable must
// stay 0755 whatever the umask), a replace that is a rename, and no temp file left behind when that
// rename fails. Temp dirs only.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeFileAtomic } from '../../src/main/hooks/write-file-atomic'

const POSIX = process.platform !== 'win32'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ccc-atomic-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const mode = (path: string): number => statSync(path).mode & 0o777

describe('writeFileAtomic', () => {
  it('creates missing parent folders and writes the content', () => {
    const path = join(root, 'a', 'b', 'hooks.json')
    writeFileAtomic(path, '{"x":1}', 0o600)
    expect(readFileSync(path, 'utf8')).toBe('{"x":1}')
    expect(readdirSync(join(root, 'a', 'b'))).toEqual(['hooks.json'])
  })

  it.skipIf(!POSIX)('sets the exact mode even under a restrictive umask', () => {
    // process.umask(mask) is per process: fine in vitest's forks pool (it throws in worker threads).
    const old = process.umask(0o077)
    try {
      const exe = join(root, 'bin', 'ccc')
      writeFileAtomic(exe, '#!/bin/sh\n', 0o755)
      // writeFileSync's mode alone would give 0700 here: the chmod is what keeps group/other x.
      expect(mode(exe)).toBe(0o755)
      const secret = join(root, 'secret.json')
      writeFileAtomic(secret, '{}', 0o600)
      expect(mode(secret)).toBe(0o600)
    } finally {
      process.umask(old)
    }
  })

  it.skipIf(!POSIX)('replaces an existing file, content and mode', () => {
    const path = join(root, 'hooks.json')
    writeFileSync(path, 'old content that is longer', { mode: 0o644 })
    writeFileAtomic(path, 'new', 0o600)
    expect(readFileSync(path, 'utf8')).toBe('new')
    expect(mode(path)).toBe(0o600)
    expect(readdirSync(root)).toEqual(['hooks.json'])
  })

  it('throws when the rename fails and leaves no temp file behind', () => {
    // A directory at the target path: the temp file is written, the rename onto it fails (EISDIR).
    const path = join(root, 'hooks.json')
    mkdirSync(path)
    expect(() => writeFileAtomic(path, '{}', 0o600)).toThrow()
    expect(readdirSync(root)).toEqual(['hooks.json'])
    expect(readdirSync(path)).toEqual([])
  })
})
