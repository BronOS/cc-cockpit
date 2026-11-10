// Task 35: the packaging config keeps the layout main relies on (the plan's smoke is manual, this
// guards the pieces that break silently). Reads electron-builder.yml, package.json and scripts only.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..', '..')
const yml = readFileSync(join(root, 'electron-builder.yml'), 'utf8')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
}

describe('electron-builder.yml', () => {
  it('clears shared write access from the packed app before making installers', () => {
    expect(yml).toMatch(/^afterPack: scripts\/after-pack\.cjs$/m)
  })

  it('never publishes and ships the build output with node-pty unpacked', () => {
    expect(yml).toMatch(/^publish: null$/m)
    // out/ holds cli, host, sdk/panel.js and preload next to main: all of it goes into app.asar.
    expect(yml).toMatch(/^ {2}- out\/\*\*$/m)
    expect(yml).toMatch(/^ {2}- node_modules\/node-pty\/\*\*$/m)
  })

  it('ships the web access worker and the packages it and the gateway load at run time', () => {
    // The worker is its own entry of the main build, out/main/mirror-worker.js, where main starts
    // it from (src/main/index.ts: join(__dirname, 'mirror-worker.js')); out/** carries it.
    const vite = readFileSync(join(root, 'electron.vite.config.ts'), 'utf8')
    expect(vite).toContain("'main/mirror-worker': resolve(__dirname, 'src/main/terminals/mirror-worker.ts')")
    expect(readFileSync(join(root, 'src', 'main', 'index.ts'), 'utf8')).toContain("nodeMirrorWorker(join(__dirname, 'mirror-worker.js'))")
    expect(yml).toMatch(/^ {2}- out\/\*\*$/m)
    // Required at run time (kept external by the build), so production dependencies, which
    // electron-builder copies into the package; a devDependency would be missing there. Pinned exactly.
    const runtime = {
      ws: '8.22.0',
      '@xterm/headless': '6.0.0',
      '@xterm/addon-serialize': '0.14.0',
      '@xterm/addon-unicode11': '0.9.0'
    }
    for (const [name, version] of Object.entries(runtime)) {
      expect(pkg.dependencies[name], name).toBe(version)
      expect(pkg.devDependencies[name], name).toBeUndefined()
    }
    // Nothing of it is unpacked or filtered out: plain JavaScript read from app.asar.
    expect(yml).not.toMatch(/^ {2}- '?!.*(xterm|ws|mirror)/m)
  })

  it('ships the bundled plugins as plain files under resources/plugins', () => {
    // main reads them from process.resourcesPath/plugins (src/main/plugins/bundled.ts bundledRoot).
    expect(yml).toMatch(/^extraResources:$/m)
    expect(yml).toMatch(/^ {2}- from: plugins\/browser$/m)
    expect(yml).toMatch(/^ {4}to: plugins\/browser$/m)
    for (const name of ['reviewer', 'editor', 'files', 'sessions', 'usage']) {
      expect(yml).toMatch(new RegExp(`^ {2}- from: plugins/${name}$`, 'm'))
      expect(yml).toMatch(new RegExp(`^ {4}to: plugins/${name}$`, 'm'))
    }
    // Page sources, tests and docs stay out of the package: the filters list files, never the whole folder.
    const reviewer = yml.slice(yml.indexOf('- from: plugins/reviewer'), yml.indexOf('- from: plugins/editor'))
    expect(reviewer).toMatch(/^ {6}- overlay\/\*\*$/m)
    expect(reviewer).not.toMatch(/src|test|docs|FRICTION/)
    // The files plugin: its panel page and icon ship, its tests and design notes do not.
    const files = yml.slice(yml.indexOf('- from: plugins/files'), yml.indexOf('- from: plugins/sessions'))
    expect(files).toMatch(/^ {6}- panels\/\*\*$/m)
    expect(files).toMatch(/^ {6}- icons\/\*\*$/m)
    expect(files).not.toMatch(/src|test|docs|FRICTION/)
    // The sessions plugin: its panel, its top-bar slot page and its icon; never its tests.
    const sessions = yml.slice(yml.indexOf('- from: plugins/sessions'), yml.indexOf('- from: plugins/usage'))
    for (const dir of ['dist', 'panels', 'slots', 'icons']) expect(sessions).toMatch(new RegExp(`^ {6}- ${dir}/\\*\\*$`, 'm'))
    expect(sessions).not.toMatch(/src|test|docs|FRICTION/)
    // The usage plugin: the same parts (panel, top-bar slot page, icon); never its tests or fixtures.
    const usage = yml.slice(yml.indexOf('- from: plugins/usage'), yml.indexOf('# The bundled terminal fonts'))
    for (const dir of ['dist', 'panels', 'slots', 'icons']) expect(usage).toMatch(new RegExp(`^ {6}- ${dir}/\\*\\*$`, 'm'))
    expect(usage).not.toMatch(/src|test|docs|FRICTION/)
    // Every bundled plugin ships its logo card for the Plugins page (usage was bundled later and first had none).
    for (const name of ['browser', 'reviewer', 'editor', 'files', 'sessions', 'usage']) {
      const end = yml.indexOf('\n  - from:', yml.indexOf(`- from: plugins/${name}`) + 1)
      const block = yml.slice(yml.indexOf(`- from: plugins/${name}`), end === -1 ? undefined : end)
      expect(block, name).toMatch(/^ {6}- preview\.png$/m)
      expect(existsSync(join(root, 'plugins', name, 'preview.png')), name).toBe(true)
    }
  })

  it('points mac and Linux at the rendered app icon, and the files exist', () => {
    expect(yml).toMatch(/^ {2}icon: build\/icon\.icns$/m)
    expect(yml).toMatch(/^ {2}icon: build\/icon\.png$/m)
    // Rendered from build/icon.svg by `npm run build:icon` and committed; a missing one would
    // only show up as Electron's default icon in a packaged build.
    expect(readFileSync(join(root, 'build', 'icon.icns')).length).toBeGreaterThan(0)
    expect(readFileSync(join(root, 'build', 'icon.png')).length).toBeGreaterThan(0)
    expect(pkg.scripts['build:icon']).toContain('scripts/render-icon.cjs')
  })

  it('package script restores node-pty through a wrapper that runs the restore even on failure', () => {
    expect(pkg.scripts.package).toContain('scripts/package.mjs')
    const script = readFileSync(join(root, 'scripts', 'package.mjs'), 'utf8')
    expect(script.indexOf("'install-app-deps'")).toBeGreaterThan(script.indexOf("'--publish', 'never'"))
  })

  // Distribution plan Task 2: the workflows and the cask rely on these exact targets and names.
  it('builds mac as an arm64 dmg only, ad-hoc signed without the hardened runtime', () => {
    const mac = yml.slice(yml.indexOf('\nmac:'), yml.indexOf('\nlinux:'))
    expect(mac).toMatch(/^ {2}identity: '-'$/m)
    expect(mac).toMatch(/^ {2}hardenedRuntime: false$/m)
    expect(mac).toMatch(/^ {4}- target: dmg$/m)
    expect(mac).toMatch(/^ {6}arch: \[arm64\]$/m)
    expect(mac).not.toMatch(/x64|zip|universal/)
    expect(mac).toMatch(/^ {2}artifactName: cc-cockpit-\$\{version\}-mac-arm64\.\$\{ext\}$/m)
  })

  it('builds Linux as x64 AppImage and deb with fixed artifact names', () => {
    const linux = yml.slice(yml.indexOf('\nlinux:'))
    expect(linux).toMatch(/^ {4}- target: AppImage$/m)
    expect(linux).toMatch(/^ {4}- target: deb$/m)
    expect(linux.match(/arch: \[x64\]/g)).toHaveLength(2)
    expect(linux).not.toMatch(/arm64|ia32/)
    expect(linux).toMatch(/^ {2}artifactName: cc-cockpit-\$\{version\}-linux-x64\.\$\{ext\}$/m)
    // The placeholder address is deliberate.
    expect(linux).toMatch(/^ {2}maintainer: .*<noreply@cc-cockpit\.invalid>$/m)
  })
})
