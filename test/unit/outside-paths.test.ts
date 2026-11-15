// The shared outside-path rule (src/shared/outside-paths.ts, design-download.md §1.2): the editor's
// cases moved over from plugins/editor/test/lsp-features.test.js, the darwin case folding, and the
// download-only refusals. The emitted copy the editor host requires is checked to give the same answers
// (its bytes are compared with a fresh build in reviewer-plugin.test.ts).
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { dataDirRefused, downloadRootRefused, outsideRefused, type OutsideEnv } from '../../src/shared/outside-paths'

const HOME = '/home/me'
const linux: OutsideEnv = { home: HOME, platform: 'linux' }
const darwin: OutsideEnv = { home: '/Users/me', platform: 'darwin' }
const home = (rel: string): string => join(HOME, rel)

const REFUSED = [
  '/proc/self/environ', '/sys/kernel', '/dev/null', '/run/user/1000/bus', '/proc', home('.ssh/id_ed25519'), home('.config/cc-cockpit/app.json'),
  home('.npmrc'), home('.git-credentials'), home('.pypirc'), home('.cargo/credentials.toml'), home('.cargo/credentials'),
  home('.bash_history'), home('.zsh_history'), home('.pgpass'),
  // No list names these: every hidden folder and file of the home is refused unless a toolchain's.
  home('.claude/.credentials.json'), home('.codex/auth.json'), home('.config/composer/auth.json'), home('.config/gh/hosts.yml'),
  home('.some-new-tool/token'), home('Projects/other/.env'), home('.local/share/keyrings/login.keyring'),
  home('.config/x/node_modules/pkg/index.d.ts'), home('.local/libfoo/x.py'), home('Library/Application Support/x/y.json'),
  home('Library/Keychains/login.keychain-db'), home('Library/Cookies/Cookies.binarycookies'),
  // Lexical tricks resolve first.
  home('Projects/../.ssh/id_ed25519'), '/tmp/../proc/self/environ',
]

const ALLOWED = [
  '/usr/lib/node_modules/x/index.d.ts', '/usr/lib/go/src/fmt/print.go', '/usr/lib/python3.12/os.py', '/tmp/report.pdf', '/procfs/x',
  home('.nvm/versions/node/v22.1.0/lib/node_modules/typescript/lib/lib.es5.d.ts'), home('.cache/typescript/5.6/node_modules/@types/node/fs.d.ts'),
  home('go/pkg/mod/github.com/x/y@v1.2.3/y.go'), home('.go/pkg/mod/golang.org/x/net@v0.1.0/a.go'), home('sdk/go1.23/src/fmt/print.go'),
  home('.composer/vendor/x/y/src/A.php'), home('.config/composer/vendor/jetbrains/phpstorm-stubs/standard/standard_0.php'),
  home('.local/lib/python3.12/site-packages/requests/api.py'), home('.pyenv/versions/3.12.1/lib/python3.12/os.py'),
  home('.local/share/uv/python/cpython-3.12/lib/python3.12/os.py'), home('.virtualenvs/app/lib/python3.12/site-packages/x.py'),
  home('.cargo/registry/src/index.crates.io-6f17d22bba15001f/serde-1.0.0/src/lib.rs'), home('.rustup/toolchains/stable/lib/rustlib/src/rust/library/std/src/lib.rs'),
  home('Projects/other/node_modules/.pnpm/x@1.0.0/node_modules/x/index.d.ts'), home('Projects/other/src/shared.ts'),
  home('x/node_modules/.bin/tsc'), home('Library/Fonts/x.ttf'),
  // The home itself is not refused by this rule (downloadRootRefused refuses it as a zip root).
  HOME,
]

// The editor host's copy, emitted from the same source by scripts/build-editor.mjs.
const emitted = createRequire(import.meta.url)(resolve(__dirname, '../../plugins/editor/dist/lib/outside-paths.js')) as {
  outsideRefused: typeof outsideRefused
}

describe('outsideRefused', () => {
  it.each(REFUSED)('refuses %s', (p) => {
    expect(outsideRefused(p, linux)).toBe(true)
    expect(emitted.outsideRefused(p, linux)).toBe(true)
  })

  it.each(ALLOWED)('allows %s', (p) => {
    expect(outsideRefused(p, linux)).toBe(false)
    expect(emitted.outsideRefused(p, linux)).toBe(false)
  })

  it('refuses what is not an absolute path', () => {
    for (const p of ['relative/x', '', '~/.ssh/id_ed25519', undefined, 42, null, '/tmp/a\0b']) expect(outsideRefused(p, linux)).toBe(true)
  })

  it('applies no home rule without an absolute home, but keeps the system roots', () => {
    for (const env of [{ home: '', platform: 'linux' }, { home: 'me', platform: 'linux' }]) {
      expect(outsideRefused(home('.ssh/id_ed25519'), env)).toBe(false)
      expect(outsideRefused('/proc/self/environ', env)).toBe(true)
    }
  })

  it('a home with a trailing slash is the same home', () => {
    expect(outsideRefused(home('.ssh/id'), { home: `${HOME}/`, platform: 'linux' })).toBe(true)
    expect(outsideRefused(home('.nvm/versions/x'), { home: `${HOME}/`, platform: 'linux' })).toBe(false)
  })

  describe('darwin compares names case-insensitively (APFS)', () => {
    it.each([
      '/Users/me/Library/Keychains/login.keychain-db',
      '/Users/me/library/keychains/login.keychain-db',
      '/Users/me/LIBRARY/Application Support/x',
      '/Users/me/Library/cookies/x',
      // The home itself spelled differently still names the home.
      '/users/me/.ssh/id_ed25519',
      '/USERS/ME/Library/Keychains',
    ])('refuses %s', (p) => {
      expect(outsideRefused(p, darwin)).toBe(true)
      expect(emitted.outsideRefused(p, darwin)).toBe(true)
    })

    it('allows the toolchain folders as spelled, and refuses another spelling of them (fails closed)', () => {
      expect(outsideRefused('/Users/me/.nvm/versions/node/v22/lib/x.d.ts', darwin)).toBe(false)
      expect(outsideRefused('/users/me/.nvm/versions/node/v22/lib/x.d.ts', darwin)).toBe(false)
      expect(outsideRefused('/Users/me/.NVM/versions/node/v22/lib/x.d.ts', darwin)).toBe(true)
      expect(outsideRefused('/Users/me/Projects/x/node_modules/.bin/tsc', darwin)).toBe(false)
    })

    it('Linux compares as typed: ~/library is not ~/Library there', () => {
      expect(outsideRefused(home('library/keychains/x'), linux)).toBe(false)
      expect(outsideRefused(home('Library/Keychains/x'), linux)).toBe(true)
    })
  })
})

describe('dataDirRefused', () => {
  it('refuses the data dir and everything in it, wherever it lies', () => {
    for (const dataDir of ['/srv/cockpit', '/home/me/Projects/app/.data', '/home/me/.config/cc-cockpit']) {
      expect(dataDirRefused(dataDir, dataDir, 'linux')).toBe(true)
      expect(dataDirRefused(join(dataDir, 'secret.key'), dataDir, 'linux')).toBe(true)
      expect(dataDirRefused(join(dataDir, 'devices/x.json'), dataDir, 'linux')).toBe(true)
      expect(dataDirRefused(`${dataDir}/../${dataDir.split('/').pop()}/app.json`, dataDir, 'linux')).toBe(true)
    }
  })

  it('allows its neighbours and a parent (the walk skips the data dir inside one)', () => {
    expect(dataDirRefused('/srv/cockpit-other/x', '/srv/cockpit', 'linux')).toBe(false)
    expect(dataDirRefused('/srv', '/srv/cockpit', 'linux')).toBe(false)
    expect(dataDirRefused('/home/me/Projects/app/src/a.ts', '/home/me/Projects/app/.data', 'linux')).toBe(false)
  })

  it('folds case on darwin only', () => {
    expect(dataDirRefused('/srv/COCKPIT/secret.key', '/srv/cockpit', 'darwin')).toBe(true)
    expect(dataDirRefused('/srv/COCKPIT/secret.key', '/srv/cockpit', 'linux')).toBe(false)
  })

  it('fails closed on a missing data dir or a non-absolute path', () => {
    expect(dataDirRefused('/tmp/x', '', 'linux')).toBe(true)
    expect(dataDirRefused('/tmp/x', 'data', 'linux')).toBe(true)
    expect(dataDirRefused('tmp/x', '/srv/cockpit', 'linux')).toBe(true)
  })
})

describe('downloadRootRefused', () => {
  it('refuses / and the home as a zip root, in any spelling', () => {
    for (const p of ['/', '//', '/tmp/..', HOME, `${HOME}/`, `${HOME}/Projects/..`]) expect(downloadRootRefused(p, linux)).toBe(true)
    expect(downloadRootRefused('/users/ME', darwin)).toBe(true)
  })

  it('allows a folder in either', () => {
    for (const p of ['/tmp', '/home', home('Projects'), home('Projects/app')]) expect(downloadRootRefused(p, linux)).toBe(false)
  })

  it('refuses what is not an absolute path', () => {
    expect(downloadRootRefused('Projects', linux)).toBe(true)
    expect(downloadRootRefused(undefined, linux)).toBe(true)
  })
})
