// The reviewer and editor plugins moved here from their own repos (plan 20261102-bundled-reviewer-editor).
// The reviewer's overlay bundle must be a fresh build of its page source (as browser-plugin.test.ts does
// for the browser host), and both manifests must pass the app's own validation. Their node:test suites
// run through `npm run test:plugins`, not vitest.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadManifest } from '../../src/main/plugins/validate'
import { isGuestAware } from '../../src/shared/manifest'

const REPO = resolve(__dirname, '../..')
const REVIEWER = join(REPO, 'plugins/reviewer')
const EDITOR = join(REPO, 'plugins/editor')
const FILES = join(REPO, 'plugins/files')
const SESSIONS = join(REPO, 'plugins/sessions')

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ccc-reviewer-plugin-'))
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('plugins/reviewer build', () => {
  it.each(['review.bundle.js', 'pdf.bundle.js'])('overlay/%s is what a fresh build of src/page produces, with no absolute path', (name) => {
    execFileSync(process.execPath, [join(REPO, 'scripts/build-reviewer.mjs'), tmp], { cwd: '/', stdio: 'pipe', timeout: 55_000 })
    const fresh = readFileSync(join(tmp, name))
    expect(fresh.equals(readFileSync(join(REVIEWER, 'overlay', name))), `stale plugins/reviewer/overlay/${name}: run \`npm run build:reviewer\``).toBe(true)
    expect(fresh.toString('utf8')).not.toContain(REPO)
  }, 60_000)
})

describe('plugins/editor build', () => {
  // One build writes both: the page bundle and the outside-path rule emitted from src/shared (design-download.md
  // §1.2), which the editor host requires; a stale rule would let the editor and `ccc download` disagree.
  it.each(['pages/file.bundle.js', 'lib/outside-paths.js'])('dist/%s is what a fresh build produces, with no absolute path', (rel) => {
    execFileSync(process.execPath, [join(REPO, 'scripts/build-editor.mjs'), tmp], { cwd: '/', stdio: 'pipe', timeout: 55_000 })
    const fresh = readFileSync(join(tmp, rel))
    expect(fresh.equals(readFileSync(join(EDITOR, 'dist', rel))), `stale plugins/editor/dist/${rel}: run \`npm run build:editor\``).toBe(true)
    expect(fresh.toString('utf8')).not.toContain(REPO)
  }, 60_000)

  it('the editor host requires the emitted rule and keeps no list of its own', () => {
    const files = readFileSync(join(EDITOR, 'dist/lib/files.js'), 'utf8')
    expect(files).toContain("require('./outside-paths')")
    expect(files).not.toMatch(/REFUSED_OUTSIDE_|ALLOWED_HIDDEN_HOME\s*=/)
  })

  it('the file tab page loads the SDK and its bundle by relative URLs only (web access serves it under a prefix)', () => {
    const html = readFileSync(join(EDITOR, 'dist/pages/file.html'), 'utf8')
    expect(html).toContain('<script src="../../__sdk/panel.js"></script>')
    expect(html).toContain('<script src="file.bundle.js"></script>')
    expect(html).not.toMatch(/(?:src|href)="\//)
    // No inline script: the plugin CSP blocks it.
    expect(html).not.toMatch(/<script>(?!<\/script>)/)
  })
})

describe('moved plugin manifests', () => {
  it.each([
    ['reviewer', REVIEWER, 'cockpit.reviewer'],
    ['editor', EDITOR, 'cockpit.editor'],
    ['files', FILES, 'cockpit.files'],
    ['sessions', SESSIONS, 'cockpit.sessions']
  ])('the %s manifest passes the app validation', async (_name, dir, id) => {
    const result = await loadManifest(dir)
    if (!result.ok) throw new Error(result.errors.join('; '))
    expect(result.manifest.id).toBe(id)
  })

  it('the reviewer gives every view its own copy of its overlays and checks a viewer\'s access itself', async () => {
    // design-overlay-views §6: without `aware` a read guest's copy is one-way, and the page starts the
    // `content` handshake itself, so it would stay blank.
    const result = await loadManifest(REVIEWER)
    if (!result.ok) throw new Error(result.errors.join('; '))
    expect(result.manifest.overlays).toEqual({ perView: true })
    expect(isGuestAware(result.manifest)).toBe(true)
  })

  it('the built hosts the manifests point at exist', async () => {
    for (const dir of [REVIEWER, EDITOR, FILES, SESSIONS]) {
      const result = await loadManifest(dir)
      if (!result.ok) throw new Error(result.errors.join('; '))
      expect(() => readFileSync(join(dir, result.manifest.main!))).not.toThrow()
    }
  })
})
