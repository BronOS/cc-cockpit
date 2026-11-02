// Distribution plan Task 7: the cask renderer (pure function and CLI) and what publish-cask.yml declares.
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const root = join(__dirname, '..', '..')
const script = join(root, 'scripts/render-cask.mjs')
const HASH = 'a'.repeat(63) + 'b'
const { renderCask } = (await import(script)) as { renderCask: (v: unknown, h: unknown) => string }

// js-yaml ships no types and this one call needs none.
const { load: parseYaml } = createRequire(__filename)('js-yaml') as { load(text: string): unknown }
interface Step {
  name?: string
  uses?: string
  run?: string
  with?: Record<string, unknown>
  env?: Record<string, string>
}
const workflow = parseYaml(readFileSync(join(root, '.github/workflows/publish-cask.yml'), 'utf8')) as {
  on: unknown
  permissions: unknown
  concurrency: unknown
  jobs: {
    newest: { if?: string; outputs: Record<string, string>; permissions?: unknown; steps: Step[] }
    cask: { needs: string; if: string; permissions?: unknown; steps: Step[] }
  }
}
const { newest, cask } = workflow.jobs
const stepNames = cask.steps.map((s) => s.name)
const pushStep = cask.steps.find((s) => s.name === 'Push to the tap')!

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
  depends_on macos: ">= :ventura"

  app "cc-cockpit.app"

  zap trash: [
    "~/Library/Application Support/cc-cockpit",
    "~/Library/Caches/cc-cockpit",
    "~/Library/Logs/cc-cockpit",
    "~/Library/Preferences/dev.cc-cockpit.app.plist",
    "~/Library/Saved Application State/dev.cc-cockpit.app.savedState",
  ]

  caveats <<~EOS
    The app is not notarised, so macOS may refuse to open it the first time. The exact step has not
    been tested on a Mac yet. Usually it is System Settings > Privacy & Security > "Open Anyway", or:
    xattr -cr /Applications/cc-cockpit.app

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

    it.each([
      ['a bad version', ['1.2.3"', HASH]],
      ['a bad hash', ['1.2.3', 'nope']],
      ['no arguments', []],
      ['a missing hash', ['1.2.3']],
      ['an extra argument', ['1.2.3', HASH, 'extra']]
    ])('exits 1 with one stderr line and no stdout on %s', (_name, args) => {
      const r = run(...args)
      expect(r.status).toBe(1)
      expect(r.stdout).toBe('')
      expect(r.stderr.trim().split('\n')).toHaveLength(1)
    })
  })

  const ruby = spawnSync('ruby', ['-v'])
  const tmp = mkdtempSync(join(tmpdir(), 'cc-cask-'))
  afterAll(() => rmSync(tmp, { recursive: true, force: true }))
  // Skipped only on a dev machine without ruby: in CI a missing ruby fails, so the check can't quietly vanish.
  it.skipIf(ruby.status !== 0 && !process.env.CI)('is valid Ruby (ruby -c)', () => {
    const file = join(tmp, 'cc-cockpit.rb')
    writeFileSync(file, renderCask('1.2.3', HASH))
    const r = spawnSync('ruby', ['-c', file], { encoding: 'utf8' })
    expect(r.stdout).toContain('Syntax OK')
    expect(r.status).toBe(0)
  })
})

describe('publish-cask.yml', () => {
  const NEWEST_TAG = '${{ needs.newest.outputs.tag }}'
  const allSteps = [...newest.steps, ...cask.steps]

  it('runs when a release is published', () => {
    expect(workflow.on).toEqual({ release: { types: ['published'] } })
  })

  // GitHub cancels a pending run when a newer one queues in the group. The workflow survives that only
  // if a run does not depend on its own event, and if every event queues a run that reconciles.
  it('serialises runs, and nothing depends on the release that triggered the run', () => {
    expect(workflow.concurrency).toEqual({ group: 'publish-cask' })
    expect(JSON.stringify(workflow)).not.toContain('github.event')
    expect(newest.if).toBeUndefined()
    expect(newest.outputs.tag).toBe('${{ steps.pick.outputs.tag }}')
    expect(cask.needs).toBe('newest')
    expect(cask.if).toBe("${{ needs.newest.outputs.tag != '' }}")
  })

  it('has read-only permissions and only first-party actions', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(newest.permissions).toBeUndefined()
    expect(cask.permissions).toBeUndefined()
    const uses = allSteps.flatMap((s) => (s.uses ? [s] : []))
    expect(uses.length).toBeGreaterThan(0)
    for (const s of uses) expect(s.uses).toMatch(/^actions\//)
    expect(uses.find((s) => s.uses!.startsWith('actions/checkout@'))!.with?.['persist-credentials']).toBe(false)
  })

  it('renders with the newest tag\'s own code', () => {
    expect(cask.steps.find((s) => s.uses?.startsWith('actions/checkout@'))!.with?.ref).toBe(`refs/tags/${NEWEST_TAG}`)
  })

  it('passes the tag through env, never into run', () => {
    const runs = cask.steps.filter((s) => s.run !== undefined)
    expect(runs).toHaveLength(3)
    for (const s of runs) {
      expect(s.run).not.toContain('${{')
      expect(s.env?.TAG).toBe(NEWEST_TAG)
    }
    expect(newest.steps[0]!.run).not.toContain('${{')
  })

  describe('picking the newest release', () => {
    const pick = newest.steps[0]!
    const tmp = mkdtempSync(join(tmpdir(), 'cc-cask-pick-'))
    afterAll(() => rmSync(tmp, { recursive: true, force: true }))

    /** The step's script as Actions runs it (`bash -e`), with a fake `gh` printing the listing. */
    function runPick(tags: string[], ghExit = 0): { status: number | null; output: string } {
      writeFileSync(join(tmp, 'gh'), `#!/bin/sh\nprintf '%s\\n' ${tags.map((t) => `'${t}'`).join(' ')}\nexit ${ghExit}\n`)
      chmodSync(join(tmp, 'gh'), 0o755)
      const outputFile = join(tmp, 'output')
      writeFileSync(outputFile, '')
      const r = spawnSync('bash', ['-e', '-c', pick.run!], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${tmp}:${process.env.PATH}`, GITHUB_OUTPUT: outputFile, GITHUB_REPOSITORY: 'BronOS/cc-cockpit' }
      })
      return { status: r.status, output: readFileSync(outputFile, 'utf8') }
    }

    it('asks the API for published stable releases only', () => {
      expect(pick.run).toContain('select((.draft | not) and (.prerelease | not))')
      expect(pick.run).toContain('--paginate')
    })

    it('takes the newest whichever was published last: 1.1.0 published after 1.2.0 still gives 1.2.0', () => {
      expect(runPick(['v1.1.0', 'v1.2.0', 'v1.0.0'])).toEqual({ status: 0, output: 'tag=v1.2.0\n' })
    })

    it('compares as versions, not as text', () => {
      expect(runPick(['v1.9.0', 'v1.10.0']).output).toBe('tag=v1.10.0\n')
    })

    it('ignores a tag that is not a plain vX.Y.Z', () => {
      expect(runPick(['v1.0.0', 'v2.0.0-rc.1', 'v01.0.0', 'nightly', 'v3.0.0;id', 'v9.0']).output).toBe('tag=v1.0.0\n')
    })

    it('gives an empty tag, and a green run, when no stable release exists', () => {
      expect(runPick([''])).toEqual({ status: 0, output: 'tag=\n' })
    })

    it('fails when the listing fails, rather than reading it as no releases', () => {
      expect(runPick(['v1.0.0'], 1).status).not.toBe(0)
    })
  })

  it('uses the tap token in the push step only, and fails clearly without it', () => {
    expect(JSON.stringify(workflow).match(/secrets\.TAP_TOKEN/g)).toHaveLength(1)
    expect(pushStep.env?.TAP_TOKEN).toBe('${{ secrets.TAP_TOKEN }}')
    expect(pushStep.run).toContain('the TAP_TOKEN secret is not set')
    for (const s of cask.steps) if (s !== pushStep) expect(JSON.stringify(s)).not.toContain('TAP_TOKEN')
  })

  it('keeps the token out of the clone URL and out of argv', () => {
    expect(pushStep.run).toContain('GIT_CONFIG_VALUE_0="Authorization: Basic $auth"')
    const gitLines = pushStep.run!.split('\n').filter((l) => /^\s*git /.test(l))
    expect(gitLines.length).toBeGreaterThan(0)
    for (const line of gitLines) expect(line).not.toMatch(/ -c |\$auth|TAP_TOKEN/)
    expect(pushStep.run).not.toMatch(/https:\/\/[^\s/]*@/)
  })

  it('leaves the cask alone when the tap already has a newer version, before it writes anything', () => {
    const run = pushStep.run!
    expect(run).toContain('sort -V')
    expect(run.indexOf('git clone')).toBeLessThan(run.indexOf('sort -V'))
    expect(run.indexOf('sort -V')).toBeLessThan(run.indexOf('cp tap/Casks/cc-cockpit.rb'))
  })

  it('checks the dmg against SHA256SUMS before rendering', () => {
    const check = cask.steps.findIndex((s) => s.run?.includes('sha256sum --check'))
    expect(check).toBeGreaterThanOrEqual(0)
    expect(check).toBeLessThan(stepNames.indexOf('Render the cask'))
  })
})
