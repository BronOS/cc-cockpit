// placeDownload on a filesystem with no hard links (exFAT, FAT32, SMB, FUSE): `link` fails with EPERM
// and the file is copied with COPYFILE_EXCL instead. The link itself is made to fail here, since a temp
// dir on the test machine has hard links.
import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ linkCode: 'EPERM' as string | undefined, copyCode: undefined as string | undefined }))

vi.mock('node:fs/promises', async (orig) => {
  const real = await orig<typeof import('node:fs/promises')>()
  return {
    ...real,
    link: async (a: string, b: string) => {
      if (state.linkCode) throw Object.assign(new Error('no links'), { code: state.linkCode })
      return real.link(a, b)
    },
    copyFile: async (a: string, b: string, mode?: number) => {
      if (state.copyCode) {
        // Dies partway: the destination exists, truncated.
        await real.writeFile(b, 'tr')
        throw Object.assign(new Error('disk full'), { code: state.copyCode })
      }
      return real.copyFile(a, b, mode)
    }
  }
})

import { placeDownload } from '../../src/main/remote/remote-downloads'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cc-place-'))
  state.linkCode = 'EPERM'
  state.copyCode = undefined
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('placeDownload without hard links', () => {
  it('copies the file and removes the temp', async () => {
    const temp = join(dir, '.cc-download-aa')
    await writeFile(temp, 'hello')
    const final = await placeDownload(temp, dir, 'a.txt')
    expect(final).toBe(join(dir, 'a.txt'))
    expect(await readFile(final, 'utf8')).toBe('hello')
    expect(await readdir(dir)).toEqual(['a.txt'])
  })

  it('never overwrites an entry or follows a dangling link: the next numbered name', async () => {
    const temp = join(dir, '.cc-download-bb')
    await writeFile(temp, 'new')
    await writeFile(join(dir, 'a.txt'), 'old')
    await symlink(join(dir, 'nowhere'), join(dir, 'a (1).txt'))
    const final = await placeDownload(temp, dir, 'a.txt')
    expect(final).toBe(join(dir, 'a (2).txt'))
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('old')
    const names = await readdir(dir)
    expect(names).not.toContain('nowhere')
    expect(names).not.toContain('.cc-download-bb')
  })

  it('removes a truncated copy and the temp when the copy fails partway', async () => {
    const temp = join(dir, '.cc-download-cc')
    await writeFile(temp, 'hello')
    state.copyCode = 'ENOSPC'
    await expect(placeDownload(temp, dir, 'a.txt')).rejects.toThrow('disk full')
    expect(await readdir(dir)).toEqual([])
  })

  it('does not copy on a link error that is not a missing-links one', async () => {
    const temp = join(dir, '.cc-download-dd')
    await writeFile(temp, 'hello')
    state.linkCode = 'EACCES'
    await expect(placeDownload(temp, dir, 'a.txt')).rejects.toThrow('no links')
    expect(await readdir(dir)).toEqual([])
  })
})
