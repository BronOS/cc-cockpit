// Task 35: the packaging config keeps the layout main relies on (the plan's smoke is manual, this
// guards the pieces that break silently). Reads electron-builder.yml, package.json and scripts only.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..', '..')
const yml = readFileSync(join(root, 'electron-builder.yml'), 'utf8')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }

describe('electron-builder.yml', () => {
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
})
