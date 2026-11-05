// Checks that a listing tells the truth about the repo it names. Usage:
//   check-entry --entry <file> [--index-url <url>]            one source file
//   check-entry --base <dir> --head <dir> [--index-url <url>] every entry that differs between two
//                                                             checkouts of the index repo
//   check-entry --fetch-previews <dir> --out <dir> [--index-url <url>]
//                                                             the preview of every listing in the
//                                                             index checkout <dir> that has none
//                                                             yet, written under <out>/previews/
// The first two also take --preview-required-from <YYYY-MM-DD|none> (preview-policy.json): from that
// day (UTC) a checked entry without `preview.png` is refused; before it, or with `none`, it passes
// with a warning annotation on the PR.
//
// The entry's repo is untrusted code and this runs in CI, so nothing from it is run: the clone is the
// app's own locked-down one (no hooks, no submodules, no lfs, one transport), there is no install or
// build step, and the checkout is only read: `plugin.json`, a stat of the file it names as `main`, and
// the framing of `preview.png` (nothing in it is decoded).
import { execFile } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, promises as fs, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { cloneArgs, gitEnv } from '../../../src/shared/git-source'
import { isPlainObject } from '../../../src/shared/guards'
import { relativePathProblem } from '../../../src/shared/manifest'
import {
  DEFAULT_MARKETPLACE_URL,
  MAX_PREVIEW_BYTES,
  PREVIEW_FILE,
  previewPath,
  previewPngProblem,
  type MarketplaceEntry
} from '../../../src/shared/marketplace'
import { within } from '../../../src/main/path-within'
import {
  MAX_ENTRY_BYTES,
  ToolError,
  entryPath,
  listEntryFiles,
  failedPreviewMarker,
  noPreviewMarker,
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
// The same bound for one publish run's preview fetches; the hourly run picks up the rest.
export const MAX_PREVIEW_FETCHES = 20
// A preview fetch has a tighter clone timeout and an overall budget, after which no new clone starts:
// the `previews` job in publish-index.yml has a timeout-minutes, and a job killed by it never reaches
// upload-artifact, so every preview that run did fetch would be lost and the next run would repeat the
// same slow clones. Worst case: the budget, plus one clone and one rev-parse started just before it ran
// out. A unit test holds the job's timeout above that.
export const PREVIEW_CLONE_TIMEOUT_MS = 60_000
export const PREVIEW_FETCH_BUDGET_MS = 10 * 60_000
// A listing whose clone failed or landed on another commit (a repo gone private, a moved tag) is not
// tried again for this long. Without it such listings would be recloned every hour and, sitting early in
// the fixed entry order, keep every later listing out of the run's MAX_PREVIEW_FETCHES slots for good.
export const PREVIEW_RETRY_AFTER_MS = 24 * 60 * 60_000
const MAX_FAILED_MARKER_BYTES = 64

export interface CheckOptions {
  /** The env git runs with; the process env when absent. */
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  /** From this day (YYYY-MM-DD, UTC) a missing `preview.png` is refused; null or absent: a warning. */
  previewRequiredFrom?: string | null
  /** The clock that date is compared with; tests pass a fixed one. */
  now?: () => Date
}

/** What one clone of the entry's repo showed. */
export interface Inspection {
  problems: string[]
  warnings: string[]
  /** The checked bytes of `preview.png`, when it is there and valid. */
  preview: Buffer | null
  /** True only when the clone worked and its HEAD is the pinned commit: what the repo says is about that commit. */
  atCommit: boolean
}

type PreviewRead = { bytes: Buffer } | { missing: true } | { problem: string }

/** `preview.png` at the root of the checkout: a regular file (a symlink could feed in some file of the runner), checked, never decoded. */
export function readPreview(dir: string): PreviewRead {
  const path = join(dir, PREVIEW_FILE)
  const stats = lstatSync(path, { throwIfNoEntry: false })
  if (stats === undefined) return { missing: true }
  if (!stats.isFile()) return { problem: `${PREVIEW_FILE} is not a regular file` }
  // Before reading: a 2 GB file must not be loaded to be told it is too large.
  if (stats.size > MAX_PREVIEW_BYTES) return { problem: `${PREVIEW_FILE}: the preview is over ${MAX_PREVIEW_BYTES / 1024} KiB` }
  const bytes = readFileSync(path)
  const problem = previewPngProblem(bytes)
  return problem === null ? { bytes } : { problem: `${PREVIEW_FILE}: ${problem}` }
}

/** True when the date has come. The date is from preview-policy.json, checked by `parseRequiredFrom`. */
function previewRequired(opts: CheckOptions): boolean {
  const from = opts.previewRequiredFrom
  if (from === undefined || from === null) return false
  return (opts.now ?? (() => new Date()))().toISOString().slice(0, 10) >= from
}

/** The value of --preview-required-from: `none` is null, otherwise a real calendar day. */
export function parseRequiredFrom(value: string | undefined): string | null {
  if (value === undefined || value === 'none') return null
  const day = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00Z`) : null
  // Round-tripped, so 2026-02-30 (which Date rolls over to March) is refused.
  if (day === null || Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== value) {
    throw new ToolError('check-entry: --preview-required-from must be YYYY-MM-DD or none')
  }
  return value
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

/** Clone the entry's repo at its tag and compare, the preview included. */
export async function inspectEntry(entry: MarketplaceEntry, opts: CheckOptions = {}): Promise<Inspection> {
  const parent = mkdtempSync(join(tmpdir(), 'check-entry-'))
  try {
    const dest = join(parent, 'repo')
    const clone = await runGit(cloneArgs(entry.repo, entry.tag, dest), parent, opts)
    // Generic on purpose: a PR picks the host, this runs on GitHub's network and the log is public, so
    // git's text would be a free probe of what answers there, and how.
    if (clone.code !== 0) {
      return {
        problems: [`could not clone tag ${quoted(entry.tag)} of ${quoted(entry.repo)}: the repo is not public, or the tag does not exist`],
        warnings: [],
        preview: null,
        atCommit: false
      }
    }
    const head = await runGit(['rev-parse', '--verify', 'HEAD'], dest, opts)
    const commit = head.stdout.trim()
    const problems: string[] = []
    const warnings: string[] = []
    // The same comparison the installer makes: a tag can move, the pinned commit cannot.
    const atCommit = head.code === 0 && commit === entry.commit
    if (!atCommit) problems.push(`the tag is at commit ${quoted(commit)}, the entry says ${quoted(entry.commit)}`)
    problems.push(...(await manifestProblems(dest, entry)))
    const preview = readPreview(dest)
    // A bad image is refused at once, grace or not: only a missing one has the grace period.
    if ('problem' in preview) problems.push(preview.problem)
    else if ('missing' in preview) {
      if (previewRequired(opts)) problems.push(`there is no ${PREVIEW_FILE} at the tag: one is required since ${String(opts.previewRequiredFrom)}`)
      else {
        const when = opts.previewRequiredFrom ? `from ${opts.previewRequiredFrom}` : 'soon'
        warnings.push(`there is no ${PREVIEW_FILE} at the tag: the listing shows a placeholder, and one will be required ${when}`)
      }
    }
    return { problems, warnings, preview: 'bytes' in preview ? preview.bytes : null, atCommit }
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
}

/** Clone the entry's repo at its tag and compare. Problems, empty when the listing is true. */
export async function checkEntry(entry: MarketplaceEntry, opts: CheckOptions = {}): Promise<string[]> {
  return (await inspectEntry(entry, opts)).problems
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

async function checkFile(
  path: string,
  indexUrl: string,
  opts: CheckOptions,
  expectedName?: string,
  basePath?: string
): Promise<{ problems: string[]; warnings: string[] }> {
  const refused = (problem: string): { problems: string[]; warnings: string[] } => ({ problems: [problem], warnings: [] })
  const parsed = parseSourceEntry(readRegularFile(path, MAX_ENTRY_BYTES), indexUrl)
  if (!parsed.ok) return refused(parsed.problem)
  if (expectedName !== undefined && expectedName !== `${parsed.entry.id}.json`) return refused('the file name must be the id plus .json')
  const retag = basePath === undefined ? null : retagProblem(basePath, parsed.entry, indexUrl)
  if (retag !== null) return refused(retag)
  const { problems, warnings } = await inspectEntry(parsed.entry, opts)
  return { problems, warnings }
}

/** True while the failure marker at `path` is younger than PREVIEW_RETRY_AFTER_MS. */
function recentlyFailed(path: string, now: Date): boolean {
  if (!existsSync(path)) return false
  let at: number
  try {
    at = Date.parse(readRegularFile(path, MAX_FAILED_MARKER_BYTES).trim())
  } catch {
    return false
  }
  // An unreadable or future time (a hand edit, a skewed clock) means try again: a marker must never
  // keep a listing from its preview for good.
  const age = now.getTime() - at
  return !Number.isNaN(at) && age >= 0 && age < PREVIEW_RETRY_AFTER_MS
}

/**
 * The previews the index checkout at `root` lacks, fetched into `out`/previews/. Run by publish-index.yml
 * in a job with no token (it clones repos somebody else controls); the publish job copies the result in
 * and build-index checks every image again before listing its hash. An entry already holding a
 * `<commit>.png` or the `<commit>.none` marker is skipped: a commit never changes, so one clone per
 * commit is enough. A clone that fails or lands on another commit writes the `<commit>.failed` marker
 * (the time of the attempt) and is retried once it is PREVIEW_RETRY_AFTER_MS old. At most
 * MAX_PREVIEW_FETCHES clones start, and none after PREVIEW_FETCH_BUDGET_MS.
 */
export async function fetchPreviews(
  root: string,
  out: string,
  indexUrl: string,
  opts: CheckOptions & { budgetMs?: number } = {}
): Promise<string[]> {
  const log: string[] = []
  const now = opts.now ?? (() => new Date())
  const cloneOpts: CheckOptions = { ...opts, timeoutMs: opts.timeoutMs ?? PREVIEW_CLONE_TIMEOUT_MS }
  const budgetMs = opts.budgetMs ?? PREVIEW_FETCH_BUDGET_MS
  const started = now().getTime()
  let fetched = 0
  for (const name of listEntryFiles(join(root, 'plugins'))) {
    let parsed: ReturnType<typeof parseSourceEntry>
    try {
      parsed = parseSourceEntry(readRegularFile(entryPath(root, name), MAX_ENTRY_BYTES), indexUrl)
    } catch {
      continue
    }
    // A bad entry is build-index's to report; the file-name rule keeps one listing per id.
    if (!parsed.ok || name !== `${parsed.entry.id}.json`) continue
    const { id, commit } = parsed.entry
    if (existsSync(join(root, previewPath(id, commit))) || existsSync(join(root, noPreviewMarker(id, commit)))) continue
    if (recentlyFailed(join(root, failedPreviewMarker(id, commit)), now())) continue
    if (fetched >= MAX_PREVIEW_FETCHES) {
      log.push(`more than ${MAX_PREVIEW_FETCHES} previews to fetch: the rest wait for the next run`)
      break
    }
    if (now().getTime() - started >= budgetMs) {
      log.push(`out of time for this run: the rest wait for the next run`)
      break
    }
    fetched++
    const seen = await inspectEntry(parsed.entry, cloneOpts)
    if (!seen.atCommit) {
      const marker = join(out, failedPreviewMarker(id, commit))
      mkdirSync(join(marker, '..'), { recursive: true })
      writeFileSync(marker, `${now().toISOString()}\n`)
      log.push(`${quoted(name)}: not fetched, the tag is not at the pinned commit or could not be cloned; retried in a day`)
      continue
    }
    const target = join(out, seen.preview !== null ? previewPath(id, commit) : noPreviewMarker(id, commit))
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, seen.preview ?? '')
    log.push(`${quoted(name)}: ${seen.preview !== null ? 'preview fetched' : 'no usable preview at this commit'}`)
  }
  return log
}

export async function main(argv: string[], opts: CheckOptions = {}): Promise<void> {
  const flags = parseFlags(argv, ['--entry', '--base', '--head', '--index-url', '--preview-required-from', '--fetch-previews', '--out'])
  const indexUrl = flags.get('--index-url') ?? DEFAULT_MARKETPLACE_URL
  const file = flags.get('--entry')
  const base = flags.get('--base')
  const head = flags.get('--head')
  const fetchRoot = flags.get('--fetch-previews')
  const out = flags.get('--out')
  const checkOpts: CheckOptions = { ...opts, previewRequiredFrom: parseRequiredFrom(flags.get('--preview-required-from')) }
  const problems: string[] = []
  const warnings: string[] = []
  if (fetchRoot !== undefined && out !== undefined) {
    for (const line of await fetchPreviews(fetchRoot, out, indexUrl, opts)) console.log(`check-entry: ${line}`)
    return
  } else if (file !== undefined) {
    const found = await checkFile(file, indexUrl, checkOpts)
    problems.push(...found.problems.map((p) => `check-entry: ${p}`))
    warnings.push(...found.warnings)
  } else if (base !== undefined && head !== undefined) {
    const names = changedEntryFiles(base, head)
    if (names.length > MAX_CHANGED_ENTRIES) throw new ToolError(`check-entry: a PR may change at most ${MAX_CHANGED_ENTRIES} entries`)
    for (const name of names) {
      const found = await checkFile(entryPath(head, name), indexUrl, checkOpts, name, entryPath(base, name))
      problems.push(...found.problems.map((p) => `check-entry: ${quoted(name)}: ${p}`))
      warnings.push(...found.warnings.map((w) => `${quoted(name)}: ${w}`))
    }
  } else {
    throw new ToolError(
      'usage: check-entry --entry <file> | --base <dir> --head <dir> [--preview-required-from <YYYY-MM-DD|none>] | --fetch-previews <dir> --out <dir> [--index-url <url>]'
    )
  }
  // A workflow command on purpose, so the warning shows on the PR; the text after it is ours, with
  // the file name quoted.
  for (const warning of warnings) console.log(`::warning::check-entry: ${warning}`)
  if (problems.length > 0) throw new ToolError(problems.join('\n'))
  console.log('check-entry: ok')
}
