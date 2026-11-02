// The hook behind electron-builder's afterPack: v0.1.0's .deb shipped a world-writable binary.
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const { dropSharedWrite, default: afterPack } = createRequire(__filename)('../../scripts/after-pack.cjs') as {
  dropSharedWrite: (dir: string) => void
  default: (context: { appOutDir: string }) => Promise<void>
}

const mode = (path: string) => lstatSync(path).mode & 0o7777

describe('after-pack', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'after-pack-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('clears group and other write at every depth and keeps the rest of the mode', () => {
    mkdirSync(join(dir, 'a/b'), { recursive: true })
    writeFileSync(join(dir, 'bin'), '')
    writeFileSync(join(dir, 'a/b/data'), '')
    writeFileSync(join(dir, 'kept'), '')
    chmodSync(join(dir, 'bin'), 0o777)
    chmodSync(join(dir, 'a/b/data'), 0o666)
    chmodSync(join(dir, 'kept'), 0o640)
    chmodSync(join(dir, 'a/b'), 0o777)
    chmodSync(join(dir, 'a'), 0o777)

    dropSharedWrite(dir)

    expect(mode(join(dir, 'bin'))).toBe(0o755)
    expect(mode(join(dir, 'a/b/data'))).toBe(0o644)
    expect(mode(join(dir, 'kept'))).toBe(0o640)
    expect(mode(join(dir, 'a/b'))).toBe(0o755)
    expect(mode(join(dir, 'a'))).toBe(0o755)
  })

  it('keeps a setuid bit, and does not follow a symlink out of the app', () => {
    const app = join(dir, 'app')
    const outside = join(dir, 'outside')
    mkdirSync(app)
    writeFileSync(outside, '')
    chmodSync(outside, 0o666)
    symlinkSync(outside, join(app, 'link'))
    writeFileSync(join(app, 'sandbox'), '')
    chmodSync(join(app, 'sandbox'), 0o4777)

    dropSharedWrite(app)

    expect(mode(outside)).toBe(0o666)
    expect(mode(join(app, 'sandbox'))).toBe(0o4755)
  })

  it('runs on the context electron-builder passes', async () => {
    writeFileSync(join(dir, 'bin'), '')
    chmodSync(join(dir, 'bin'), 0o777)
    await afterPack({ appOutDir: dir })
    expect(mode(join(dir, 'bin'))).toBe(0o755)
  })
})
