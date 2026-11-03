// notifications/system-sounds.ts: the fixed OS sound folders per platform, the listing rules
// (extensions, regular files, symlinks that stay inside the root, size and count caps, depth,
// freedesktop first, duplicate names) and the id checks of a pick and of a bytes read, over temp dirs.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listSystemSounds, SystemSounds, systemSoundRoots, type SoundRoot } from '../../src/main/notifications/system-sounds'
import { BUILTIN_SOUNDS, MAX_SYSTEM_SOUNDS } from '../../src/shared/notify-sound'

let base: string
let sys: string
let user: string
let roots: SoundRoot[]

/** A file of `size` bytes (default 4) at `rel` under `dir`, its folders made. */
function put(dir: string, rel: string, size = 4): string {
  const path = join(dir, rel)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, Buffer.alloc(size, 7))
  return path
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'cc-sounds-'))
  sys = join(base, 'sys')
  user = join(base, 'user')
  mkdirSync(sys)
  roots = [
    { dir: sys, label: 'System sounds' },
    { dir: user, label: 'Your sounds' }
  ]
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('systemSoundRoots', () => {
  it('is fixed per platform, the home folder the only input', () => {
    expect(systemSoundRoots('linux', {}, '/home/me')).toEqual([
      { dir: '/usr/share/sounds', label: 'System sounds' },
      { dir: '/home/me/.local/share/sounds', label: 'Your sounds' }
    ])
    expect(systemSoundRoots('darwin', {}, '/Users/me')).toEqual([
      { dir: '/System/Library/Sounds', label: 'macOS sounds' },
      { dir: '/Users/me/Library/Sounds', label: 'Your sounds' }
    ])
    expect(systemSoundRoots('win32', { WINDIR: 'D:\\Win' }, 'C:\\Users\\me')).toEqual([{ dir: 'D:\\Win\\Media', label: 'Windows sounds' }])
    // A WINDIR that is not an absolute path is not trusted to be the Windows folder.
    expect(systemSoundRoots('win32', { WINDIR: 'Win' }, 'C:\\Users\\me')[0]?.dir).toBe('C:\\Windows\\Media')
    expect(systemSoundRoots('win32', { SystemRoot: 'E:\\W' }, 'C:\\Users\\me')[0]?.dir).toBe('E:\\W\\Media')
  })
})

describe('listSystemSounds', () => {
  it('lists the audio extensions only (any case), skips dot files, empty and oversized files', async () => {
    for (const ext of ['oga', 'ogg', 'wav', 'aiff', 'aif', 'mp3', 'flac']) put(sys, `a-${ext}.${ext}`)
    put(sys, 'LOUD.WAV')
    put(sys, 'readme.txt')
    put(sys, 'index.theme')
    put(sys, '.hidden.wav')
    put(sys, 'empty.wav', 0)
    put(sys, 'big.wav', 2 * 1024 * 1024 + 1)
    put(sys, 'just-under.wav', 2 * 1024 * 1024)
    const listed = await listSystemSounds(roots)
    expect(listed.map((s) => s.rel).sort()).toEqual(
      ['LOUD.WAV', 'a-aif.aif', 'a-aiff.aiff', 'a-flac.flac', 'a-mp3.mp3', 'a-oga.oga', 'a-ogg.ogg', 'a-wav.wav', 'just-under.wav'].sort()
    )
    expect(listed.find((s) => s.rel === 'a-oga.oga')).toMatchObject({ id: 'system:0:a-oga.oga', name: 'a oga', root: 0 })
  })

  it('follows a symlink inside the root but never one that leaves it, and does not enter linked folders', async () => {
    const target = put(sys, 'theme/stereo/bell.oga')
    symlinkSync(target, join(sys, 'theme', 'stereo', 'alias.oga'))
    const secret = put(base, 'outside/secret.wav')
    symlinkSync(secret, join(sys, 'escape.wav'))
    // A relative link that climbs out works the same way.
    symlinkSync('../outside/secret.wav', join(sys, 'climb.wav'))
    symlinkSync(join(base, 'outside'), join(sys, 'linked-dir'))
    symlinkSync(join(sys, 'nowhere.wav'), join(sys, 'dangling.wav'))
    mkdirSync(join(sys, 'folder.wav'))
    const listed = await listSystemSounds(roots)
    expect(listed.map((s) => s.rel).sort()).toEqual(['theme/stereo/alias.oga', 'theme/stereo/bell.oga'])
    // The realpath is what main reads.
    expect(listed.find((s) => s.rel === 'theme/stereo/alias.oga')?.path.endsWith(join('theme', 'stereo', 'bell.oga'))).toBe(true)
  })

  it('walks only so deep', async () => {
    put(sys, 'a/b/c/d/four.wav')
    put(sys, 'a/b/c/d/e/five.wav')
    expect((await listSystemSounds(roots)).map((s) => s.rel)).toEqual(['a/b/c/d/four.wav'])
    expect((await listSystemSounds(roots, { maxDepth: 1 })).map((s) => s.rel)).toEqual([])
  })

  it("lists freedesktop's stereo sounds first, then other stereo folders, then the rest; the cap keeps the first", async () => {
    put(sys, 'aaa.wav')
    put(sys, 'zeta/stereo/z.oga')
    put(sys, 'freedesktop/stereo/message.oga')
    put(sys, 'freedesktop/mono/message.oga')
    put(user, 'mine.wav')
    const listed = await listSystemSounds(roots)
    expect(listed.map((s) => s.id)).toEqual([
      'system:0:freedesktop/stereo/message.oga',
      'system:0:zeta/stereo/z.oga',
      'system:0:aaa.wav',
      'system:0:freedesktop/mono/message.oga',
      'system:1:mine.wav'
    ])
    expect((await listSystemSounds(roots, { maxSounds: 2 })).map((s) => s.rel)).toEqual(['freedesktop/stereo/message.oga', 'zeta/stereo/z.oga'])
  })

  it(`stops at ${MAX_SYSTEM_SOUNDS} sounds over all folders`, async () => {
    for (let i = 0; i < MAX_SYSTEM_SOUNDS + 5; i++) put(sys, `s${String(i).padStart(3, '0')}.wav`, 1)
    put(user, 'mine.wav')
    const listed = await listSystemSounds(roots)
    expect(listed).toHaveLength(MAX_SYSTEM_SOUNDS)
    expect(listed.every((s) => s.root === 0)).toBe(true)
  })

  it('names a shared stem by its folder, and by its extension when that still clashes', async () => {
    put(sys, 'freedesktop/stereo/bell.oga')
    put(sys, 'other/stereo/bell.oga')
    put(sys, 'other/stereo/bell.wav')
    put(sys, 'dialog_warning.wav')
    put(sys, 'Top.wav')
    put(user, 'top.wav')
    const names = Object.fromEntries((await listSystemSounds(roots)).map((s) => [s.id, s.name]))
    expect(names).toEqual({
      'system:0:freedesktop/stereo/bell.oga': 'bell (freedesktop/stereo)',
      'system:0:other/stereo/bell.oga': 'bell (other/stereo, oga)',
      'system:0:other/stereo/bell.wav': 'bell (other/stereo, wav)',
      'system:0:dialog_warning.wav': 'dialog warning',
      'system:0:Top.wav': 'Top',
      // Another root is another dropdown group: no clash.
      'system:1:top.wav': 'top'
    })
  })

  it('skips a root that does not exist', async () => {
    put(user, 'mine.wav')
    rmSync(sys, { recursive: true })
    expect((await listSystemSounds(roots)).map((s) => s.id)).toEqual(['system:1:mine.wav'])
  })
})

describe('SystemSounds', () => {
  it('groups the built-ins first, then each root that has sounds, names and ids only', async () => {
    put(sys, 'freedesktop/stereo/bell.oga')
    const groups = await new SystemSounds(roots).groups()
    expect(groups).toEqual([
      { label: 'Built-in', sounds: BUILTIN_SOUNDS.map((s) => ({ id: `builtin:${s.name}`, name: s.title })) },
      { label: 'System sounds', sounds: [{ id: 'system:0:freedesktop/stereo/bell.oga', name: 'bell' }] }
    ])
    expect(groups[0]?.sounds[0]).toEqual({ id: 'builtin:chime', name: 'Chime' })
  })

  it('serves the bytes of a listed sound, and null for anything a fresh listing does not hold', async () => {
    const bell = put(sys, 'freedesktop/stereo/bell.oga', 10)
    put(base, 'outside/secret.wav')
    symlinkSync(join(base, 'outside', 'secret.wav'), join(sys, 'escape.wav'))
    const sounds = new SystemSounds(roots)
    const got = await sounds.read('system:0:freedesktop/stereo/bell.oga')
    expect(got?.type).toBe('audio/ogg')
    expect(got?.data).toEqual(new Uint8Array(10).fill(7))
    expect(await sounds.has('system:0:freedesktop/stereo/bell.oga')).toBe(true)
    for (const id of [
      'system:0:escape.wav',
      'system:0:../outside/secret.wav',
      'system:0:/etc/passwd',
      'system:5:freedesktop/stereo/bell.oga',
      'system:1:freedesktop/stereo/bell.oga',
      'builtin:chime',
      join(sys, 'freedesktop', 'stereo', 'bell.oga'),
      42
    ]) {
      expect(await sounds.read(id)).toBeNull()
    }
    expect(await sounds.has('system:0:escape.wav')).toBe(false)
    // Gone since it was picked: no bytes, the page rings the Chime.
    rmSync(bell)
    expect(await sounds.read('system:0:freedesktop/stereo/bell.oga')).toBeNull()
    expect(await sounds.has('system:0:freedesktop/stereo/bell.oga')).toBe(false)
  })

  it('reads nothing once the file grew past the cap', async () => {
    const path = put(sys, 'grow.wav', 8)
    const sounds = new SystemSounds(roots, { maxBytes: 16 })
    expect(await sounds.read('system:0:grow.wav')).not.toBeNull()
    writeFileSync(path, Buffer.alloc(32))
    expect(await sounds.read('system:0:grow.wav')).toBeNull()
  })
})
