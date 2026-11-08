// Distribution plan Task 6: workflows can't run locally, so this checks the release tag script and what the
// workflow files declare. Parsed, so a reformat can't fail a check and a comment can't fail or satisfy one.
// Their first real run is on GitHub.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

// js-yaml ships no types and this one call needs none.
const { load: parseYaml } = createRequire(__filename)('js-yaml') as { load(text: string): unknown }

const root = join(__dirname, '..', '..')
const workflowsDir = join(root, '.github', 'workflows')

interface Step {
  name?: string
  uses?: string
  run?: string
  with?: Record<string, unknown>
  env?: Record<string, string>
}
interface Job {
  needs?: string | string[]
  uses?: string
  permissions?: Record<string, string>
  strategy?: { matrix: { os?: string[]; include?: Array<{ os: string; files: string }> } }
  steps?: Step[]
}
interface Workflow {
  on: Record<string, { branches?: string[]; tags?: string[] } | null>
  permissions?: Record<string, string>
  jobs: Record<string, Job>
}

function workflow(name: string): Workflow {
  return parseYaml(readFileSync(join(workflowsDir, name), 'utf8')) as Workflow
}

const stepsOf = (w: Workflow | Job): Step[] => ('jobs' in w ? Object.values(w.jobs).flatMap((j) => j.steps ?? []) : (w.steps ?? []))

/** The shell of every `run:`. */
const runBlocks = (w: Workflow | Job): string[] => stepsOf(w).flatMap((s) => (s.run === undefined ? [] : [s.run.trim()]))

describe('check-release-tag.mjs', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cc-release-tag-'))
  afterAll(() => rmSync(tmp, { recursive: true, force: true }))

  function check(tag: string, version: unknown): { status: number | null; stdout: string; stderr: string } {
    const pkg = join(tmp, 'package.json')
    writeFileSync(pkg, JSON.stringify({ version }))
    return spawnSync(process.execPath, [join(root, 'scripts/check-release-tag.mjs'), tag, pkg], { encoding: 'utf8' })
  }

  it('passes silently when the tag is v + a stable version', () => {
    expect(check('v1.2.3', '1.2.3')).toMatchObject({ status: 0, stdout: '', stderr: '' })
    expect(check('v0.10.0', '0.10.0').status).toBe(0)
  })

  it('checks the real package.json when no path is given', () => {
    const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }
    const script = join(root, 'scripts/check-release-tag.mjs')
    expect(spawnSync(process.execPath, [script, `v${version}`], { cwd: tmp }).status).toBe(0)
    expect(spawnSync(process.execPath, [script, 'v999.0.0'], { cwd: tmp }).status).toBe(1)
  })

  it('fails on a mismatch and names both sides', () => {
    const r = check('v1.2.4', '1.2.3')
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('v1.2.4')
    expect(r.stderr).toContain('v1.2.3')
  })

  it.each([
    ['v1.2.3-rc.1', '1.2.3-rc.1'],
    ['v1.2.3-beta', '1.2.3-beta'],
    ['v1.2.3+build', '1.2.3+build']
  ])('fails on the prerelease or build tag %s even when it matches package.json', (tag, version) => {
    const r = check(tag, version)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('stable')
  })

  it.each(['', '1.2.3', 'v1.2', 'v1.2.3.4', 'v01.2.3', 'V1.2.3', 'vv1.2.3', 'v1.2.3\n', ' v1.2.3', 'release', 'v1.2.3;id'])(
    'fails on the junk tag %j',
    (tag) => {
      expect(check(tag, '1.2.3').status).toBe(1)
    }
  )

  it.each([undefined, 123, '01.2.3', '1.2', '1.2.3\n'])('fails on the package.json version %j', (version) => {
    expect(check('v1.2.3', version).status).toBe(1)
  })

  it('fails on an unreadable package.json', () => {
    const r = spawnSync(process.execPath, [join(root, 'scripts/check-release-tag.mjs'), 'v1.2.3', join(tmp, 'missing.json')], { encoding: 'utf8' })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('cannot read')
  })
})

// Every workflow, so a file added later (publish-cask.yml) comes under the same rules by itself.
describe.each(readdirSync(workflowsDir))('%s', (file) => {
  const w = workflow(file)
  const text = JSON.stringify(w)

  it('reads by default and never runs on pull_request_target', () => {
    expect(w.permissions).toEqual({ contents: 'read' })
    expect(Object.keys(w.on)).not.toContain('pull_request_target')
    expect(text).not.toMatch(/write-all/)
  })

  it('uses first-party actions pinned to a commit, or its own workflows', () => {
    const uses = [...Object.values(w.jobs).map((j) => j.uses), ...stepsOf(w).map((s) => s.uses)].filter((u) => u !== undefined)
    expect(uses.length).toBeGreaterThan(0)
    for (const action of uses) expect(action).toMatch(/^(actions\/[\w-]+@[0-9a-f]{40}|\.\/\.github\/workflows\/[\w-]+\.yml)$/)
  })

  it('checks out without keeping credentials, and pins Node with no npm cache', () => {
    for (const step of stepsOf(w)) {
      if (step.uses?.startsWith('actions/checkout@')) expect(step.with?.['persist-credentials']).toBe(false)
      if (step.uses?.startsWith('actions/setup-node@')) {
        expect(step.with?.['node-version']).toMatch(/^\d+\.\d+\.\d+$/)
        expect(step.with).not.toHaveProperty('cache')
        // setup-node v5+ caches by itself once package.json names a packageManager: off, explicitly.
        expect(step.with?.['package-manager-cache']).toBe(false)
      }
      expect(step.uses ?? '').not.toContain('actions/cache')
    }
  })

  it('never interpolates into a shell: values reach it through env', () => {
    for (const block of runBlocks(w)) expect(block).not.toContain('${{')
  })
})

describe('ci.yml', () => {
  const ci = workflow('ci.yml')

  it('runs on PRs, master and when release.yml calls it', () => {
    expect(ci.on).toEqual({ pull_request: null, push: { branches: ['master'] }, workflow_call: null })
  })

  it('runs typecheck, lint, unit tests and the bundled plugin tests on Mac and Linux, and no e2e', () => {
    expect(ci.jobs.checks!.strategy!.matrix.os).toEqual(['macos-15', 'ubuntu-latest'])
    expect(runBlocks(ci)).toEqual(['npm ci', 'npm run typecheck', 'npm run lint', 'npm test', 'npm run test:plugins'])
  })
})

describe('release.yml', () => {
  const release = workflow('release.yml')
  const { tag, checks, build, release: last } = release.jobs as Record<'tag' | 'checks' | 'build' | 'release', Job>

  it('runs on v tags only', () => {
    expect(release.on).toEqual({ push: { tags: ['v*'] } })
  })

  it('checks the tag first, with the value in env, then the same checks as CI, then builds, then releases', () => {
    const check = stepsOf(tag).find((s) => s.run?.includes('check-release-tag'))!
    expect(check.env?.TAG).toBe('${{ github.ref_name }}')
    expect(check.run).toBe('node scripts/check-release-tag.mjs "$TAG"')
    expect(tag.needs).toBeUndefined()
    expect(checks.needs).toBe('tag')
    expect(checks.uses).toBe('./.github/workflows/ci.yml')
    expect(build.needs).toBe('checks')
    expect(last.needs).toEqual(['tag', 'build'])
  })

  it('creates a draft, and nothing can make it anything else', () => {
    const creates = runBlocks(release).filter((b) => b.includes('gh release'))
    expect(creates).toHaveLength(1)
    expect(creates[0]).toMatch(/^gh release create "\$TAG" /)
    expect(creates[0]).toContain('--draft')
    expect(creates[0]).toContain('--verify-tag')
    expect(creates[0]).not.toContain('--prerelease')
  })

  it('grants write on the release job only, which runs nothing from the repo', () => {
    expect(last.permissions).toEqual({ contents: 'write' })
    for (const job of [tag, checks, build]) expect(job.permissions).toBeUndefined()
    expect(stepsOf(last).map((s) => s.uses ?? '').join()).not.toContain('actions/checkout')
    for (const block of runBlocks(last)) expect(block).not.toMatch(/\bnpm\b|\bnode\b/)
  })

  it('has one token, in the step that creates the draft, and no secrets', () => {
    const withToken = stepsOf(release).filter((s) => s.env?.GH_TOKEN !== undefined)
    expect(withToken.map((s) => s.name)).toEqual(['Create the draft'])
    expect(withToken[0]!.env!.GH_TOKEN).toBe('${{ github.token }}')
    expect(JSON.stringify(release).match(/GH_TOKEN/g)).toHaveLength(1)
    expect(JSON.stringify(release)).not.toContain('secrets.')
  })

  it('builds without a token or a publish flag', () => {
    expect(runBlocks(build)).toContain('npm run package')
    expect(JSON.stringify(build)).not.toMatch(/token|--publish|-p always|secrets\.|permissions/i)
    expect(build.strategy!.matrix.include!.map((i) => i.os)).toEqual(['macos-15', 'ubuntu-22.04'])
  })

  it('uploads the dmg, deb, AppImage and SHA256SUMS, with the names electron-builder.yml gives them', () => {
    const yml = readFileSync(join(root, 'electron-builder.yml'), 'utf8')
    expect(yml).toContain('artifactName: cc-cockpit-${version}-mac-arm64.${ext}')
    expect(yml).toContain('artifactName: cc-cockpit-${version}-linux-x64.${ext}')
    const files = build.strategy!.matrix.include!.map((i) => i.files).join('\n')
    for (const glob of ['cc-cockpit-*-mac-arm64.dmg', 'cc-cockpit-*-linux-x64.AppImage', 'cc-cockpit-*-linux-x64.deb']) {
      expect(files).toContain(`release/${glob}`)
    }
    const upload = stepsOf(build).find((s) => s.uses?.startsWith('actions/upload-artifact@'))!
    expect(upload.with?.path).toBe('${{ matrix.files }}')
    expect(upload.with?.['if-no-files-found']).toBe('error')
    const shell = runBlocks(last).join('\n')
    for (const name of ['mac-arm64.dmg', 'linux-x64.AppImage', 'linux-x64.deb']) expect(shell).toContain(`cc-cockpit-$version-${name}`)
    expect(shell).toContain('sha256sum -- * > SHA256SUMS')
    expect(shell).toContain('assets/*')
  })
})
