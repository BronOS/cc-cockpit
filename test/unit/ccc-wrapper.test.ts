// Task 35: where the wrapper finds the Electron binary and the CLI (dev and packaged layouts), and
// the "Install ccc command" link in ~/.local/bin. Real fs in a temp dir; nothing touches the real
// HOME, data dir or ~/.local/bin. (The wrapper's own basics are in hooks-file.test.ts.)
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CccCommandInstaller } from '../../src/main/hooks/ccc-install'
import {
  resolveWrapperTargets,
  wrapperScript,
  writeCccWrapper
} from '../../src/main/hooks/ccc-wrapper'

const POSIX = process.platform !== 'win32'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ccc-wrapper-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('resolveWrapperTargets', () => {
  const base = { execPath: '/x/electron', resourcesPath: '/x/resources', mainDir: '/repo/out/main', dataDir: '/data' }

  it('dev: the CLI is out/cli next to out/main, and process.resourcesPath is not read', () => {
    expect(resolveWrapperTargets({ ...base, isPackaged: false, resourcesPath: '/nonsense' })).toEqual({
      electronBinary: '/x/electron',
      cliEntry: '/repo/out/cli/index.js',
      dataDir: '/data'
    })
  })

  it('packaged: the CLI is inside resources/app.asar and the binary is the app itself', () => {
    expect(
      resolveWrapperTargets({
        ...base,
        isPackaged: true,
        execPath: '/Applications/cc-cockpit.app/Contents/MacOS/cc-cockpit',
        resourcesPath: '/Applications/cc-cockpit.app/Contents/Resources',
        mainDir: '/ignored'
      })
    ).toEqual({
      electronBinary: '/Applications/cc-cockpit.app/Contents/MacOS/cc-cockpit',
      cliEntry: '/Applications/cc-cockpit.app/Contents/Resources/app.asar/out/cli/index.js',
      dataDir: '/data',
      presenceFile: '/Applications/cc-cockpit.app/Contents/Resources/app.asar'
    })
  })
})

describe('wrapper for the packaged layout', () => {
  it('checks the archive file, not a path inside it (a shell cannot test into app.asar)', () => {
    const packaged = resolveWrapperTargets({
      isPackaged: true, execPath: '/x/e', resourcesPath: '/R', mainDir: '/m', dataDir: '/d'
    })
    expect(wrapperScript(packaged)).toContain("[ -f '/R/app.asar' ] || exit 0")
    // The layout decides, not the path text: a dev tree under a "*.asar" directory still tests the CLI file.
    const dev = resolveWrapperTargets({
      isPackaged: false, execPath: '/x/e', resourcesPath: '/R', mainDir: '/w.asar/out/main', dataDir: '/d'
    })
    expect(wrapperScript(dev)).toContain("[ -f '/w.asar/out/cli/index.js' ] || exit 0")
  })

  it('quotes paths with spaces and apostrophes in the packaged layout too', () => {
    const text = wrapperScript({
      electronBinary: "/Apps/O'Brien's cc/Contents/MacOS/cc-cockpit",
      cliEntry: "/Apps/O'Brien's cc/Contents/Resources/app.asar/out/cli/index.js",
      dataDir: '/Users/a b/Library/Application Support/cc-cockpit',
      presenceFile: "/Apps/O'Brien's cc/Contents/Resources/app.asar"
    })
    expect(text).toContain(`[ -f '/Apps/O'\\''Brien'\\''s cc/Contents/Resources/app.asar' ] || exit 0`)
    expect(text).toContain(
      `CC_COCKPIT_DATA_DIR='/Users/a b/Library/Application Support/cc-cockpit' ELECTRON_RUN_AS_NODE=1 exec '/Apps/O'\\''Brien'\\''s cc/Contents/MacOS/cc-cockpit' '/Apps/O'\\''Brien'\\''s cc/Contents/Resources/app.asar/out/cli/index.js' "$@"`
    )
  })

  // The bug this guards: with `[ -f <archive>/out/cli/index.js ]` the wrapper exited 0 on every
  // call of a packaged app, so hooks silently never reached it.
  it.skipIf(!POSIX)('runs the binary when app.asar exists and exits 0 silently when it is gone', () => {
    const res = join(root, 'my app', 'Resources')
    mkdirSync(res, { recursive: true })
    // A sh script stands in for the app binary; it reports what it was handed.
    const bin = join(root, 'my app', 'cc-cockpit')
    writeFileSync(bin, '#!/bin/sh\necho "ran:$1:$2:$ELECTRON_RUN_AS_NODE"\n')
    chmodSync(bin, 0o755)
    const asar = join(res, 'app.asar')
    writeFileSync(asar, 'not a real archive')
    const wrapper = join(root, 'data', 'bin', 'ccc')
    writeCccWrapper(wrapper, resolveWrapperTargets({
      isPackaged: true,
      execPath: bin,
      resourcesPath: res,
      mainDir: '/unused',
      dataDir: join(root, 'data')
    }))

    const ran = spawnSync(wrapper, ['hook'], { encoding: 'utf8' })
    expect(ran.status).toBe(0)
    expect(ran.stdout).toBe(`ran:${join(asar, 'out', 'cli', 'index.js')}:hook:1\n`)

    rmSync(asar)
    const gone = spawnSync(wrapper, ['hook'], { encoding: 'utf8' })
    expect(gone.status).toBe(0)
    expect(gone.stdout).toBe('')
    expect(gone.stderr).toBe('')
  })
})

describe('CccCommandInstaller', () => {
  function rig(loginPath?: string) {
    const home = join(root, 'home dir')
    mkdirSync(home, { recursive: true })
    const wrapperPath = join(root, 'data', 'bin', 'ccc')
    const installer = new CccCommandInstaller({ home, wrapperPath, loginPath: () => loginPath })
    const link = join(home, '.local', 'bin', 'ccc')
    return { home, wrapperPath, installer, link }
  }

  it('reports "missing" before, creates ~/.local/bin and the link, and is idempotent', () => {
    const r = rig()
    expect(r.installer.view()).toMatchObject({ state: 'missing', linkPath: r.link, target: r.wrapperPath })
    const view = r.installer.install()
    expect(view.state).toBe('installed')
    expect(readlinkSync(r.link)).toBe(r.wrapperPath)
    expect(r.installer.install().state).toBe('installed')
    expect(readlinkSync(r.link)).toBe(r.wrapperPath)
  })

  it('keeps an existing ~/.local/bin and what is in it', () => {
    const r = rig()
    mkdirSync(join(r.home, '.local', 'bin'), { recursive: true })
    writeFileSync(join(r.home, '.local', 'bin', 'other'), 'x')
    r.installer.install()
    expect(lstatSync(join(r.home, '.local', 'bin', 'other')).isFile()).toBe(true)
    expect(lstatSync(r.link).isSymbolicLink()).toBe(true)
  })

  it('refuses to overwrite a regular file', () => {
    const r = rig()
    mkdirSync(join(r.home, '.local', 'bin'), { recursive: true })
    writeFileSync(r.link, 'my own script')
    expect(r.installer.view().state).toBe('foreign')
    expect(() => r.installer.install()).toThrow(/already exists and is not the ccc link/)
    expect(lstatSync(r.link).isFile()).toBe(true)
  })

  it('refuses a symlink that points elsewhere, a dangling one, and a link to another data dir', () => {
    for (const target of [join(root, 'elsewhere'), join(root, 'does', 'not', 'exist'), join(root, 'other-data', 'bin', 'ccc')]) {
      const r = rig()
      mkdirSync(join(r.home, '.local', 'bin'), { recursive: true })
      symlinkSync(target, r.link)
      expect(() => r.installer.install()).toThrow(/not the ccc link/)
      expect(readlinkSync(r.link)).toBe(target)
      rmSync(r.home, { recursive: true, force: true })
    }
  })

  it('refuses a directory at the link path', () => {
    const r = rig()
    mkdirSync(r.link, { recursive: true })
    expect(() => r.installer.install()).toThrow(/not the ccc link/)
    expect(lstatSync(r.link).isDirectory()).toBe(true)
  })

  it('fails (without touching anything) when ~/.local is a file', () => {
    const r = rig()
    writeFileSync(join(r.home, '.local'), 'a file')
    expect(() => r.installer.install()).toThrow()
    expect(lstatSync(join(r.home, '.local')).isFile()).toBe(true)
  })

  it('reports the real cause, not "foreign", when the path cannot be inspected', () => {
    const r = rig()
    writeFileSync(join(r.home, '.local'), 'a file')
    expect(() => r.installer.view()).toThrow(/cannot inspect .*ccc/)
    expect(() => r.installer.install()).toThrow(/cannot inspect/)
  })

  // The race: a link appears between the lstat and the symlink. Simulated by making the first
  // state() see "missing" while the path is already taken.
  it.each([
    ['ours', true],
    ['foreign', false]
  ])('EEXIST race with %s link', (_name, ours) => {
    const r = rig()
    mkdirSync(join(r.home, '.local', 'bin'), { recursive: true })
    symlinkSync(ours ? r.wrapperPath : join(root, 'elsewhere'), r.link)
    const real = Object.getPrototypeOf(r.installer).state as () => string
    let first = true
    ;(r.installer as unknown as { state: () => string }).state = function (this: unknown) {
      if (first) {
        first = false
        return 'missing'
      }
      return real.call(this)
    }
    if (ours) expect(r.installer.install().state).toBe('installed')
    else expect(() => r.installer.install()).toThrow(/appeared meanwhile/)
    expect(readlinkSync(r.link)).toBe(ours ? r.wrapperPath : join(root, 'elsewhere'))
  })

  it('says whether ~/.local/bin is on the login PATH (empty entries and look-alikes do not count)', () => {
    const r = rig()
    const bin = join(r.home, '.local', 'bin')
    expect(r.installer.view().onPath).toBe(false)
    expect(rig(['/usr/bin', bin].join(delimiter)).installer.view().onPath).toBe(true)
    expect(rig(`/usr/bin${delimiter}${bin}/`).installer.view().onPath).toBe(true)
    expect(rig(['', '/usr/bin', `${bin}x`, join(r.home, 'bin')].join(delimiter)).installer.view().onPath).toBe(false)
  })
})
