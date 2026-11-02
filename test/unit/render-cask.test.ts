// Distribution plan Task 7: the cask renderer (pure function and CLI) and what publish-cask.yml declares.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const root = join(__dirname, '..', '..')
const script = join(root, 'scripts/render-cask.mjs')
const HASH = 'a'.repeat(63) + 'b'
const { renderCask } = (await import(script)) as { renderCask: (v: unknown, h: unknown) => string }

const workflow = readFileSync(join(root, '.github/workflows/publish-cask.yml'), 'utf8').replace(/^\s*#.*\n/gm, '')

describe('renderCask', () => {
  it('renders the cask for a known input', () => {
    expect(renderCask('1.2.3', HASH)).toBe(`cask "cc-cockpit" do
  version "1.2.3"
  sha256 "${HASH}"

  url "https://github.com/BronOS/cc-cockpit/releases/download/v#{version}/cc-cockpit-#{version}-mac-arm64.dmg"
  name "cc-cockpit"
  desc "Desktop cockpit for Claude Code sessions"
  homepage "https://github.com/BronOS/cc-cockpit"

  depends_on arch: :arm64

  app "cc-cockpit.app"

  zap trash: [
    "~/Library/Application Support/cc-cockpit",
    "~/Library/Caches/cc-cockpit",
    "~/Library/Logs/cc-cockpit",
    "~/Library/Preferences/dev.cc-cockpit.app.plist",
    "~/Library/Saved Application State/dev.cc-cockpit.app.savedState",
  ]

  caveats <<~EOS
    The app is not notarised. On first launch, open System Settings > Privacy & Security and
    choose "Open Anyway", or run: xattr -cr /Applications/cc-cockpit.app

    Quit cc-cockpit before upgrading, or restart it afterwards.
  EOS
end
`)
  })

  it.each(['', '1.2', 'v1.2.3', '1.2.3-beta.1', '01.2.3', '1.2.3"', '1.2.3#{`id`}', '1.2.3\nend', 7, undefined])(
    'refuses the version %j',
    (version) => {
      expect(() => renderCask(version, HASH)).toThrow(/invalid version/)
    }
  )

  it.each(['', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), `${'a'.repeat(62)}"\n`, `${'a'.repeat(60)}#{x}`, null])(
    'refuses the hash %j',
    (hash) => {
      expect(() => renderCask('1.2.3', hash)).toThrow(/invalid sha256/)
    }
  )

  describe('CLI', () => {
    const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })

    it('prints the cask on success', () => {
      const r = run('1.2.3', HASH)
      expect(r).toMatchObject({ status: 0, stderr: '' })
      expect(r.stdout).toBe(renderCask('1.2.3', HASH))
    })

    it('exits 1 with one stderr line and no stdout on bad input', () => {
      const r = run('1.2.3"', HASH)
      expect(r.status).toBe(1)
      expect(r.stdout).toBe('')
      expect(r.stderr.trim().split('\n')).toHaveLength(1)
    })
  })

  const ruby = spawnSync('ruby', ['-v'])
  const tmp = mkdtempSync(join(tmpdir(), 'cc-cask-'))
  afterAll(() => rmSync(tmp, { recursive: true, force: true }))
  it.skipIf(ruby.status !== 0)('is valid Ruby (ruby -c)', () => {
    const file = join(tmp, 'cc-cockpit.rb')
    writeFileSync(file, renderCask('1.2.3', HASH))
    const r = spawnSync('ruby', ['-c', file], { encoding: 'utf8' })
    expect(r.stdout).toContain('Syntax OK')
    expect(r.status).toBe(0)
  })
})

describe('publish-cask.yml', () => {
  it('runs only when a release is published, and not for prereleases', () => {
    expect(workflow).toMatch(/^on:\n {2}release:\n {4}types: \[published\]\n/m)
    expect(workflow).toContain('if: ${{ !github.event.release.prerelease }}')
    expect(workflow).not.toMatch(/pull_request/)
  })

  it('has read-only permissions and only first-party actions', () => {
    expect(workflow).toMatch(/^permissions:\n {2}contents: read\n/m)
    expect(workflow).not.toMatch(/contents: write/)
    for (const m of workflow.matchAll(/uses: (\S+)/g)) expect(m[1]).toMatch(/^actions\//)
    expect(workflow).toContain('persist-credentials: false')
  })

  it('passes tag_name through env, never into run', () => {
    expect(workflow).toContain('TAG: ${{ github.event.release.tag_name }}')
    // Every `run:` block (the body is the lines indented deeper than `run:`).
    const lines = workflow.split('\n')
    const bodies: string[] = []
    lines.forEach((line, i) => {
      const m = /^(\s*)run: ?(.*)$/.exec(line)
      if (!m) return
      let body = m[2]!
      for (let j = i + 1; j < lines.length && (lines[j]!.trim() === '' || lines[j]!.search(/\S/) > m[1]!.length); j++) {
        body += `\n${lines[j]}`
      }
      bodies.push(body)
    })
    expect(bodies).toHaveLength(3)
    expect(bodies.join('\n')).not.toContain('${{')
  })

  it('uses the tap token in the push step only, and fails clearly without it', () => {
    expect(workflow.match(/secrets\.TAP_TOKEN/g)).toHaveLength(1)
    const push = workflow.slice(workflow.indexOf('- name: Push to the tap'))
    expect(push).toContain('secrets.TAP_TOKEN')
    expect(push).toContain('the TAP_TOKEN secret is not set')
    expect(workflow.slice(0, workflow.indexOf('- name: Push to the tap'))).not.toContain('TAP_TOKEN')
  })

  it('checks the dmg against SHA256SUMS before rendering', () => {
    expect(workflow).toContain('sha256sum --check')
    expect(workflow.indexOf('sha256sum --check')).toBeLessThan(workflow.indexOf('render-cask.mjs'))
  })
})
