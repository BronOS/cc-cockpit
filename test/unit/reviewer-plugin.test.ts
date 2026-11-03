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

const REPO = resolve(__dirname, '../..')
const REVIEWER = join(REPO, 'plugins/reviewer')
const EDITOR = join(REPO, 'plugins/editor')
const FILES = join(REPO, 'plugins/files')

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ccc-reviewer-plugin-'))
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('plugins/reviewer build', () => {
  it('overlay/review.bundle.js is what a fresh build of src/page produces, with no absolute path', () => {
    const out = join(tmp, 'review.bundle.js')
    execFileSync(process.execPath, [join(REPO, 'scripts/build-reviewer.mjs'), out], { cwd: '/', stdio: 'pipe', timeout: 55_000 })
    const fresh = readFileSync(out)
    expect(fresh.equals(readFileSync(join(REVIEWER, 'overlay/review.bundle.js'))), 'stale plugins/reviewer/overlay/review.bundle.js: run `npm run build:reviewer`').toBe(true)
    expect(fresh.toString('utf8')).not.toContain(REPO)
  }, 60_000)
})

describe('moved plugin manifests', () => {
  it.each([
    ['reviewer', REVIEWER, 'cockpit.reviewer'],
    ['editor', EDITOR, 'cockpit.editor'],
    ['files', FILES, 'cockpit.files']
  ])('the %s manifest passes the app validation', async (_name, dir, id) => {
    const result = await loadManifest(dir)
    if (!result.ok) throw new Error(result.errors.join('; '))
    expect(result.manifest.id).toBe(id)
  })

  it('the built hosts the manifests point at exist', async () => {
    for (const dir of [REVIEWER, EDITOR, FILES]) {
      const result = await loadManifest(dir)
      if (!result.ok) throw new Error(result.errors.join('; '))
      expect(() => readFileSync(join(dir, result.manifest.main!))).not.toThrow()
    }
  })
})
