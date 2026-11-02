// Checks that a listing tells the truth about the repo it names. Usage:
//   check-entry --entry <file> [--index-url <url>]            one source file
//   check-entry --base <dir> --head <dir> [--index-url <url>] every entry that differs between two
//                                                             checkouts of the index repo
//
// The entry's repo is untrusted code and this runs in CI, so nothing from it is run: the clone is the
// app's own locked-down one (no hooks, no submodules, no lfs, one transport), there is no install or
// build step, and the checkout is only read: `plugin.json`, and a stat of the file it names as `main`.
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, promises as fs, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { cloneArgs, gitEnv } from '../../../src/shared/git-source'
import { isPlainObject } from '../../../src/shared/guards'
import { relativePathProblem } from '../../../src/shared/manifest'
import { DEFAULT_MARKETPLACE_URL, type MarketplaceEntry } from '../../../src/shared/marketplace'
import { within } from '../../../src/main/path-within'
import {
  MAX_ENTRY_BYTES,
  ToolError,
  entryPath,
  listEntryFiles,
  parseFlags,
  parseSourceEntry,
  quoted,
  readRegularFile,
  sameEntryFile
} from './common'

const GIT_TIMEOUT_MS = 120_000
const MAX_MANIFEST_BYTES = 256 * 1024
// Each changed entry is a clone. A human bulk edit can be split; a runner should not clone hundreds
// of repos because one PR said so.
const MAX_CHANGED_ENTRIES = 20

export interface CheckOptions {
  /** The env git runs with; the process env when absent. */
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
}

function runGit(args: string[], cwd: string, opts: CheckOptions): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    execFile(
      'git',
      args,
      // `as` because gitEnv keeps the login-env shape, undefined values included, which execFile ignores.
      { cwd, env: gitEnv(opts.env ?? process.env) as NodeJS.ProcessEnv, timeout: opts.timeoutMs ?? GIT_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err === null ? 0 : typeof err.code === 'number' ? err.code : 1
        done({ code, stdout, stderr: err !== null && stderr === '' ? err.message : stderr })
      }
    )
  })
}

/** What is wrong with the checkout in `dir` against `entry`. */
export async function manifestProblems(dir: string, entry: MarketplaceEntry): Promise<string[]> {
  let manifest: unknown
  try {
    manifest = JSON.parse(readRegularFile(join(dir, 'plugin.json'), MAX_MANIFEST_BYTES))
  } catch {
    return ['plugin.json is missing, too large, a symlink or not valid JSON']
  }
  if (!isPlainObject(manifest)) return ['plugin.json is not a JSON object']
  const problems: string[] = []
  for (const field of ['id', 'version', 'api'] as const) {
    if (manifest[field] !== entry[field]) {
      problems.push(`plugin.json ${field} is ${quoted(manifest[field])}, the entry says ${quoted(entry[field])}`)
    }
  }
  // `main` is optional (a theme-only plugin), but one that is named must be built and committed:
  // a plugin ships JavaScript and nothing is compiled on install.
  const main = manifest.main
  if (main !== undefined) {
    const problem = typeof main === 'string' ? relativePathProblem(main) : 'is not a string'
    if (problem !== null) problems.push(`plugin.json main ${problem}`)
    // The installer deletes the clone's .git before install, so a main inside it exists here and not there.
    else if ((main as string).split(/[\\/]/)[0] === '.git') problems.push(`plugin.json main ${quoted(main)} is inside .git, which is not installed`)
    else if (!(await isFileInside(dir, main as string))) problems.push(`plugin.json main ${quoted(main)} is not a file in the repo at this tag`)
  }
  return problems
}

// realpath first: a symlink out of the repo must not pass because its target exists on the runner.
async function isFileInside(dir: string, rel: string): Promise<boolean> {
  try {
    const root = await fs.realpath(dir)
    const real = await fs.realpath(resolve(root, rel))
    return within(root, real) && (await fs.stat(real)).isFile()
  } catch {
    return false
  }
}

/** Clone the entry's repo at its tag and compare. Problems, empty when the listing is true. */
export async function checkEntry(entry: MarketplaceEntry, opts: CheckOptions = {}): Promise<string[]> {
  const parent = mkdtempSync(join(tmpdir(), 'check-entry-'))
  try {
    const dest = join(parent, 'repo')
    const clone = await runGit(cloneArgs(entry.repo, entry.tag, dest), parent, opts)
    // Generic on purpose: a PR picks the host, this runs on GitHub's network and the log is public, so
    // git's text would be a free probe of what answers there, and how.
    if (clone.code !== 0) return [`could not clone tag ${quoted(entry.tag)} of ${quoted(entry.repo)}: the repo is not public, or the tag does not exist`]
    const head = await runGit(['rev-parse', '--verify', 'HEAD'], dest, opts)
    const commit = head.stdout.trim()
    const problems: string[] = []
    // The same comparison the installer makes: a tag can move, the pinned commit cannot.
    if (head.code !== 0 || commit !== entry.commit) problems.push(`the tag is at commit ${quoted(commit)}, the entry says ${quoted(entry.commit)}`)
    problems.push(...(await manifestProblems(dest, entry)))
    return problems
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
}

/** The entry file names in `head` that are new or differ from `base`. A deletion needs no check. */
export function changedEntryFiles(base: string, head: string): string[] {
  // Compared, not read: an unchanged symlink or oversized file on main must not fail a PR that does
  // not touch it (see build-index.ts). One the PR adds or changes fails when checkFile reads it.
  return listEntryFiles(join(head, 'plugins')).filter((name) => !sameEntryFile(base, head, name))
}

/**
 * A new commit needs a new version. The app installs into `<id>@<version>` and refuses an update to
 * the version it has, so users of a re-tagged fix would be stranded on the old commit, a revoked one
 * above all: uninstalling, their only way out then, wipes the plugin's secrets.
 */
function retagProblem(basePath: string, entry: MarketplaceEntry, indexUrl: string): string | null {
  if (!existsSync(basePath)) return null
  let text: string
  try {
    text = readRegularFile(basePath, MAX_ENTRY_BYTES)
  } catch {
    // Nothing to compare with, and throwing here would refuse the very PR that repairs this file.
    return null
  }
  const before = parseSourceEntry(text, indexUrl)
  if (!before.ok || before.entry.commit === entry.commit || before.entry.version.toLowerCase() !== entry.version.toLowerCase()) return null
  return 'a new commit needs a new version: installed copies cannot update to the version they already have'
}

async function checkFile(path: string, indexUrl: string, opts: CheckOptions, expectedName?: string, basePath?: string): Promise<string[]> {
  const parsed = parseSourceEntry(readRegularFile(path, MAX_ENTRY_BYTES), indexUrl)
  if (!parsed.ok) return [parsed.problem]
  if (expectedName !== undefined && expectedName !== `${parsed.entry.id}.json`) return ['the file name must be the id plus .json']
  const retag = basePath === undefined ? null : retagProblem(basePath, parsed.entry, indexUrl)
  if (retag !== null) return [retag]
  return checkEntry(parsed.entry, opts)
}

export async function main(argv: string[], opts: CheckOptions = {}): Promise<void> {
  const flags = parseFlags(argv, ['--entry', '--base', '--head', '--index-url'])
  const indexUrl = flags.get('--index-url') ?? DEFAULT_MARKETPLACE_URL
  const file = flags.get('--entry')
  const base = flags.get('--base')
  const head = flags.get('--head')
  const problems: string[] = []
  if (file !== undefined) {
    problems.push(...(await checkFile(file, indexUrl, opts)).map((p) => `check-entry: ${p}`))
  } else if (base !== undefined && head !== undefined) {
    const names = changedEntryFiles(base, head)
    if (names.length > MAX_CHANGED_ENTRIES) throw new ToolError(`check-entry: a PR may change at most ${MAX_CHANGED_ENTRIES} entries`)
    for (const name of names) {
      const found = await checkFile(entryPath(head, name), indexUrl, opts, name, entryPath(base, name))
      problems.push(...found.map((p) => `check-entry: ${quoted(name)}: ${p}`))
    }
  } else {
    throw new ToolError('usage: check-entry --entry <file> | --base <dir> --head <dir> [--index-url <url>]')
  }
  if (problems.length > 0) throw new ToolError(problems.join('\n'))
  console.log('check-entry: ok')
}
