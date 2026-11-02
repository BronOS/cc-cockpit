// Distribution plan Task 6: workflows can't run locally, so this checks the release tag script and what the
// workflow files declare. Text checks in the style of packaging-config.test.ts, with comments stripped so
// a comment naming a forbidden thing can't fail (or satisfy) a check. Their first real run is on GitHub.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const root = join(__dirname, '..', '..')
const workflowsDir = join(root, '.github', 'workflows')

function workflow(name: string): string {
  return readFileSync(join(workflowsDir, name), 'utf8').replace(/^\s*#.*\n/gm, '')
}

/** A job's text: from its two-space key to the next one. Throws on a missing job so a rename fails loudly. */
function job(text: string, name: string): string {
  const start = text.indexOf(`\n  ${name}:\n`)
  if (start < 0) throw new Error(`no job ${name}`)
  const next = text.slice(start + 1).search(/\n {2}[\w-]+:\n/)
  return next < 0 ? text.slice(start) : text.slice(start, start + 1 + next)
}

/** The shell of every `run:`, single-line or block. */
function runBlocks(text: string): string[] {
  const lines = text.split('\n')
  const blocks: string[] = []
  lines.forEach((line, i) => {
    const m = /^(\s*)(?:- )?run: ?(.*)$/.exec(line)
    if (!m) return
    const indent = m[1]!.length
    let block = m[2]!
    for (let j = i + 1; j < lines.length && (lines[j]!.trim() === '' || lines[j]!.search(/\S/) > indent); j++) {
      block += `\n${lines[j]}`
    }
    blocks.push(block.trim())
  })
  return blocks
}

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
  const text = workflow(file)

  it('reads by default and never runs on pull_request_target', () => {
    expect(text).toMatch(/^permissions:\n {2}contents: read$/m)
    expect(text).not.toContain('pull_request_target')
    expect(text).not.toMatch(/write-all/)
  })

  it('uses first-party actions only, or its own workflows', () => {
    const uses = [...text.matchAll(/^\s*(?:- )?uses: (\S+)/gm)].map((m) => m[1]!)
    expect(uses.length).toBeGreaterThan(0)
    for (const action of uses) expect(action).toMatch(/^(actions\/[\w-]+@v\d+|\.\/\.github\/workflows\/[\w-]+\.yml)$/)
  })

  it('checks out without keeping credentials, and pins Node with no npm cache', () => {
    const checkouts = text.match(/uses: actions\/checkout@/g) ?? []
    expect(text.match(/persist-credentials: false/g)?.length ?? 0).toBe(checkouts.length)
    const nodes = text.match(/uses: actions\/setup-node@/g) ?? []
    expect(text.match(/node-version: \d+\.\d+\.\d+$/gm)?.length ?? 0).toBe(nodes.length)
    expect(text).not.toMatch(/^\s*cache(-dependency-path)?:/m)
    expect(text).not.toContain('actions/cache')
  })

  it('never interpolates into a shell: values reach it through env', () => {
    for (const block of runBlocks(text)) expect(block).not.toContain('${{')
  })
})

describe('ci.yml', () => {
  const ci = workflow('ci.yml')

  it('runs on PRs, master and when release.yml calls it', () => {
    expect(ci).toMatch(/^ {2}pull_request:$/m)
    expect(ci).toMatch(/^ {2}push:\n {4}branches: \[master\]$/m)
    expect(ci).toMatch(/^ {2}workflow_call:$/m)
  })

  it('runs typecheck, lint and unit tests on Mac and Linux, and no e2e', () => {
    expect(ci).toContain('os: [macos-14, ubuntu-latest]')
    expect(runBlocks(ci)).toEqual(['npm ci', 'npm run typecheck', 'npm run lint', 'npm test'])
  })
})

describe('release.yml', () => {
  const release = workflow('release.yml')

  it('runs on v tags only', () => {
    expect(release).toMatch(/^on:\n {2}push:\n {4}tags: \['v\*'\]\npermissions:/m)
  })

  it('checks the tag first, with the value in env, then the same checks as CI, then builds, then releases', () => {
    const tag = job(release, 'tag')
    expect(tag).toContain('TAG: ${{ github.ref_name }}')
    expect(tag).toContain('node scripts/check-release-tag.mjs "$TAG"')
    expect(job(release, 'checks')).toMatch(/needs: tag\n\s+uses: \.\/\.github\/workflows\/ci\.yml/)
    expect(job(release, 'build')).toContain('needs: checks')
    expect(job(release, 'release')).toContain('needs: [tag, build]')
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
    expect(release.match(/contents: write/g)).toHaveLength(1)
    const last = job(release, 'release')
    expect(last).toContain('contents: write')
    expect(last).not.toContain('actions/checkout')
    expect(last).not.toMatch(/\bnpm\b|\bnode\b/)
  })

  it('has one token, in the step that creates the draft, and no secrets', () => {
    expect(release.match(/GH_TOKEN/g)).toHaveLength(1)
    expect(release).not.toContain('secrets.')
    const step = job(release, 'release').slice(job(release, 'release').indexOf('- name: Create the draft'))
    expect(step).toContain('GH_TOKEN: ${{ github.token }}')
  })

  it('builds without a token or a publish flag', () => {
    const build = job(release, 'build')
    expect(build).toContain('npm run package')
    expect(build).not.toMatch(/token|--publish|-p always|secrets\.|permissions:/i)
    expect(build).toMatch(/os: macos-14[\s\S]*os: ubuntu-22.04/)
  })

  it('uploads the dmg, deb, AppImage and SHA256SUMS, with the names electron-builder.yml gives them', () => {
    const yml = readFileSync(join(root, 'electron-builder.yml'), 'utf8')
    expect(yml).toContain('artifactName: cc-cockpit-${version}-mac-arm64.${ext}')
    expect(yml).toContain('artifactName: cc-cockpit-${version}-linux-x64.${ext}')
    const build = job(release, 'build')
    for (const glob of ['cc-cockpit-*-mac-arm64.dmg', 'cc-cockpit-*-linux-x64.AppImage', 'cc-cockpit-*-linux-x64.deb']) {
      expect(build).toContain(`release/${glob}`)
    }
    expect(build).toContain('if-no-files-found: error')
    const last = job(release, 'release')
    for (const name of ['mac-arm64.dmg', 'linux-x64.AppImage', 'linux-x64.deb']) expect(last).toContain(`cc-cockpit-$version-${name}`)
    expect(last).toContain('sha256sum -- * > SHA256SUMS')
    expect(last).toContain('assets/*')
  })
})
