// Task 35: the packaging config keeps the layout main relies on (the plan's smoke is manual, this
// guards the pieces that break silently). Reads electron-builder.yml, package.json and scripts only.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..', '..')
const yml = readFileSync(join(root, 'electron-builder.yml'), 'utf8')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }

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

  it('ships the bundled plugins as plain files under resources/plugins', () => {
    // main reads them from process.resourcesPath/plugins (src/main/plugins/bundled.ts bundledRoot).
    expect(yml).toMatch(/^extraResources:$/m)
    expect(yml).toMatch(/^ {2}- from: plugins\/browser$/m)
    expect(yml).toMatch(/^ {4}to: plugins\/browser$/m)
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
