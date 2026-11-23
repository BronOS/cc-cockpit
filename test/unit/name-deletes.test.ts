// Name-based deletes (design-upload.md §13 "Name-based deletes", external review iteration 3): an
// ancestor of the folder swapped for a link to another folder after the identity check must not
// redirect the unlink there. Node has no `unlinkat`, so the folder's real path is re-checked just before
// the unlink (`unlinkInDir`); the swap is made here right after the real `lstat` returns, the moment the
// old code went straight on to `unlink`.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  /** Called once after a real `lstat` of this path returned, before the caller sees the result. */
  swapAt: undefined as string | undefined,
  swap: undefined as (() => void) | undefined,
}))

vi.mock('node:fs/promises', async (orig) => {
  const real = await orig<typeof import('node:fs/promises')>()
  return {
    ...real,
    lstat: async (...args: Parameters<typeof real.lstat>) => {
      const st = await real.lstat(...args)
      if (state.swap && args[0] === state.swapAt) {
        const swap = state.swap
        state.swap = undefined
        swap()
      }
      return st
    },
  }
})

import { removeIfOwn, unlinkInDir } from '../../src/main/files/copy-exclusive'
import { UploadWriter } from '../../src/main/files/upload-writer'

let tmp: string
/** The project: `proj/sub` is the folder the deletes act in. */
let proj: string
/** A folder only the owner writes, holding a file with the same name as the one deleted. */
let privateDir: string

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-name-deletes-')))
  proj = join(tmp, 'proj')
  privateDir = join(tmp, 'private')
  mkdirSync(join(proj, 'sub'), { recursive: true })
  mkdirSync(privateDir)
  state.swapAt = undefined
  state.swap = undefined
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

/** At `path`'s lstat: `proj/sub` renamed aside and a link to the private folder put in its place. */
function swapAncestorAt(path: string): void {
  state.swapAt = path
  state.swap = () => {
    renameSync(join(proj, 'sub'), join(proj, 'sub-aside'))
    symlinkSync(privateDir, join(proj, 'sub'))
  }
}

describe('removeIfOwn', () => {
  it('removes its own file while the folder still resolves where it was made', async () => {
    const path = join(proj, 'sub', 'a.txt')
    writeFileSync(path, 'ours')
    expect(await removeIfOwn(path, statSync(path))).toBe('removed')
    expect(existsSync(path)).toBe(false)
  })

  it('never unlinks through an ancestor swapped for a link after its identity check', async () => {
    const path = join(proj, 'sub', 'config.json')
    writeFileSync(path, 'ours')
    writeFileSync(join(privateDir, 'config.json'), 'private')
    const own = statSync(path)
    swapAncestorAt(path)
    expect(await removeIfOwn(path, own)).toBe('failed')
    expect(readFileSync(join(privateDir, 'config.json'), 'utf8')).toBe('private')
    // Ours is left where the swap moved it: `failed` keeps a temp's record for the next start.
    expect(readFileSync(join(proj, 'sub-aside', 'config.json'), 'utf8')).toBe('ours')
  })
})

describe('unlinkInDir', () => {
  it('compares the real path, never the lexical folder', async () => {
    // The folder named through a link (as macOS's /var is): its real path is what was recorded.
    symlinkSync(join(proj, 'sub'), join(tmp, 'via'))
    writeFileSync(join(proj, 'sub', 'b.txt'), 'ours')
    expect(await unlinkInDir(join(tmp, 'via', 'b.txt'), join(proj, 'sub'))).toBe('removed')
    expect(await unlinkInDir(join(proj, 'sub', 'b.txt'), join(proj, 'sub'))).toBe('absent')
    writeFileSync(join(privateDir, 'c.txt'), 'private')
    expect(await unlinkInDir(join(privateDir, 'c.txt'), join(proj, 'sub'))).toBe('failed')
    expect(existsSync(join(privateDir, 'c.txt'))).toBe(true)
  })
})

describe('the start sweep', () => {
  it('keeps an entry whose folder was swapped for a link after its lstat, deleting nothing', async () => {
    const name = '.cc-upload-0123456789abcdef'
    const temp = join(proj, 'sub', name)
    writeFileSync(temp, 'partial')
    writeFileSync(join(privateDir, name), 'private')
    const tempsFile = join(tmp, 'data', 'uploads', 'temps.json')
    mkdirSync(join(tmp, 'data', 'uploads'), { recursive: true })
    writeFileSync(tempsFile, JSON.stringify({ schemaVersion: 1, temps: [{ path: temp, root: proj }] }))
    const writer = new UploadWriter({
      grants: () => {
        throw new Error('the sweep reads no grants')
      },
      projectRoot: () => proj,
      tempsFile,
      log: () => undefined,
    })
    swapAncestorAt(temp)
    expect(await writer.sweepTemps()).toBe(0)
    expect(readFileSync(join(privateDir, name), 'utf8')).toBe('private')
    expect(readFileSync(join(proj, 'sub-aside', name), 'utf8')).toBe('partial')
    // Kept for the next start, whose realpath and `within` check drop it while it leads out of the project.
    const kept = (JSON.parse(readFileSync(tempsFile, 'utf8')) as { temps: Array<{ path: string }> }).temps.map((e) => e.path)
    expect(kept).toEqual([temp])
  })
})
