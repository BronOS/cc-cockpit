// The overlay kit (kit/README.md) is committed built: plugins vendor kit/dist, kit/host/shared-page.js, VERSION and
// SHA256SUMS as bytes and pin them by the sums. This rebuilds the kit into a temp dir and compares every byte, as
// reviewer-plugin.test.ts does for the editor and the Reviewer, and checks the kit-demo fixture's vendored copy.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const REPO = join(__dirname, '../..')
const KIT = join(REPO, 'kit')
const DEMO = join(REPO, 'test/fixtures/plugins/kit-demo/kit')
const VENDORED = ['dist/cc-kit.js', 'dist/cc-kit.css', 'host/shared-page.js', 'VERSION', 'SHA256SUMS']

describe('the overlay kit build', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cc-kit-build-'))
  afterAll(() => rmSync(tmp, { recursive: true, force: true }))

  it('kit/dist and kit/SHA256SUMS are what scripts/build-kit.mjs makes, byte for byte', () => {
    execFileSync(process.execPath, [join(REPO, 'scripts/build-kit.mjs'), tmp], { cwd: '/', stdio: 'pipe', timeout: 55_000 })
    for (const rel of ['dist/cc-kit.js', 'dist/cc-kit.css', 'SHA256SUMS']) {
      const fresh = readFileSync(join(tmp, rel))
      expect(fresh.equals(readFileSync(join(KIT, rel))), `stale kit/${rel}: run \`npm run build:kit\``).toBe(true)
    }
  })

  it('SHA256SUMS names every vendored file with its hash', () => {
    const lines = readFileSync(join(KIT, 'SHA256SUMS'), 'utf8').trim().split('\n')
    const named = lines.map((l) => l.split('  ')[1]).sort()
    expect(named).toEqual(['VERSION', 'dist/cc-kit.css', 'dist/cc-kit.js', 'host/shared-page.js'])
    for (const line of lines) {
      const [sum, name = ''] = line.split('  ')
      expect(createHash('sha256').update(readFileSync(join(KIT, name))).digest('hex'), name).toBe(sum)
    }
  })

  it("the kit-demo fixture's vendored kit is the master copy's bytes", () => {
    for (const rel of VENDORED) {
      expect(readFileSync(join(DEMO, rel)).equals(readFileSync(join(KIT, rel))), `stale kit-demo kit/${rel}: copy it from kit/`).toBe(true)
    }
  })

  it('the bundle is a classic script defining ccKit, with no import, require or markup write', () => {
    const js = readFileSync(join(KIT, 'dist/cc-kit.js'), 'utf8')
    expect(js).toContain('var ccKit = ')
    // Code lines only: esbuild keeps some doc comments of the bundled packages (linkify-it's mentions require).
    const code = js
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join('\n')
    expect(code).not.toMatch(/^\s*import\s|\brequire\(/m)
    expect(js).not.toMatch(/\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML\s*\(|document\.write/)
    expect(js).toContain(`overlay kit ${readFileSync(join(KIT, 'VERSION'), 'utf8').trim()} `)
  })
})
