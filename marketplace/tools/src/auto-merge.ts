// Decides whether a green PR is a routine version bump a machine may merge. Run by auto-merge.yml on
// `workflow_run`, from main, so nothing in the PR can change this code. Read-only: it prints the
// decision into $GITHUB_OUTPUT and the workflow does the merge, pinned to the head commit it decided
// on, after checking that main is still the commit decided against (`base`). Anything but a clean yes
// stays for a human, and that is not a failure.
//
// The inputs are read from `main` and from the API, never from the check's outcome alone: check.yml
// runs the PR's own copy of the workflow, so its green tick says little until this has established
// that the PR touches one entry file and no workflow.
import { writeFileSync, appendFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { isPlainObject } from '../../../src/shared/guards'
import { PLUGIN_ID_MAX_LENGTH, PLUGIN_ID_PATTERN } from '../../../src/shared/manifest'
import { DEFAULT_MARKETPLACE_URL, compareVersions } from '../../../src/shared/marketplace'
import { ToolError, parseRevoked, parseSourceEntry } from './common'

/** The only fields a bump may change. */
const BUMP_FIELDS = new Set(['version', 'tag', 'commit', 'api'])
const DEFAULT_BRANCH = 'main'

export interface PullSummary {
  number: number
  draft: boolean
  authorId: number
  headSha: string
  /** null when the fork is gone. */
  headRepo: string | null
  baseRef: string
}

export interface PullFile {
  filename: string
  status: string
}

export type Decision = { merge: true; id: string } | { merge: false; reason: string }

/**
 * The PR a `workflow_run` is about. `workflow_run.pull_requests` is empty for a fork, so it is found
 * by head commit among the open PRs. Two matches (anyone can open a second PR from the same commit)
 * are ambiguous and go to a human.
 */
export function resolvePullRequest(open: PullSummary[], headSha: string, headRepo: string): PullSummary | null {
  const matches = open.filter((pr) => pr.headSha === headSha && pr.headRepo === headRepo)
  return matches.length === 1 ? (matches[0] as PullSummary) : null
}

/** The id a one-file PR is about, when the file list has the shape of a bump; null otherwise. */
export function bumpedId(files: PullFile[]): string | null {
  const file = files[0]
  if (files.length !== 1 || file === undefined || file.status !== 'modified') return null
  const match = /^plugins\/(.+)\.json$/.exec(file.filename)
  const id = match?.[1]
  if (id === undefined || id.length > PLUGIN_ID_MAX_LENGTH || !PLUGIN_ID_PATTERN.test(id)) return null
  return id
}

export interface DecisionInput {
  pr: PullSummary
  /** What the PR changes, from a comparison of two fixed commits; never the PR's live file list. */
  files: PullFile[]
  /** `plugins/<id>.json` on main and at the PR's head; null when absent. */
  mainEntryText: string | null
  headEntryText: string | null
  /** `revoked.json` on main; null when absent. */
  revokedText: string | null
}

function no(reason: string): Decision {
  return { merge: false, reason }
}

/**
 * The auto-merge rule, pure: exactly one file, modified, named after the id, the author a listed owner
 * on main, only the bump fields differing from main, a higher version, a commit not revoked. Compared
 * with main's current file rather than the PR's diff, so a stale branch that would also roll back
 * somebody's `owners` edit does not pass as a bump.
 */
export function decideAutoMerge(input: DecisionInput): Decision {
  const { pr, files } = input
  if (pr.draft) return no('the PR is a draft')
  if (pr.baseRef !== DEFAULT_BRANCH) return no('the PR does not target main')
  const id = bumpedId(files)
  if (id === null) return no('the PR is not a change to exactly one existing plugins/<id>.json')
  if (input.mainEntryText === null) return no('the entry does not exist on main')
  if (input.headEntryText === null) return no('the entry could not be read at the PR head')

  const onMain = parseSourceEntry(input.mainEntryText, DEFAULT_MARKETPLACE_URL)
  if (!onMain.ok) return no(`the entry on main is invalid: ${onMain.problem}`)
  const atHead = parseSourceEntry(input.headEntryText, DEFAULT_MARKETPLACE_URL)
  if (!atHead.ok) return no(`the entry in the PR is invalid: ${atHead.problem}`)
  if (onMain.entry.id !== id || atHead.entry.id !== id) return no('the id does not match the file name')

  // A numeric id, read from main: the PR cannot add its own author, and a login could change hands.
  if (!onMain.owners.includes(pr.authorId)) return no('the author is not an owner of this entry')

  const keys = new Set([...Object.keys(onMain.raw), ...Object.keys(atHead.raw)])
  for (const key of keys) {
    if (!BUMP_FIELDS.has(key) && !isDeepStrictEqual(onMain.raw[key], atHead.raw[key])) {
      return no(`the PR changes "${key}", which is not a version bump`)
    }
  }
  if (compareVersions(atHead.entry.version, onMain.entry.version) <= 0) return no('the version does not increase')

  // Fails closed: unreadable revocations are no reason to let a commit through.
  if (input.revokedText === null) return no('revoked.json is missing on main')
  const revoked = parseRevoked(input.revokedText)
  if (!revoked.ok) return no(`revoked.json on main is invalid: ${revoked.problem}`)
  if (revoked.revoked.some((r) => r.commit === atHead.entry.commit)) return no('the commit is revoked')
  return { merge: true, id }
}

export type FetchLike = (url: string, init: { headers: Record<string, string> }) => Promise<{
  ok: boolean
  status: number
  json(): Promise<unknown>
  text(): Promise<string>
}>

const API_BASE = 'https://api.github.com'
const PER_PAGE = 100
// Far past any open-PR count here.
const MAX_PAGES = 100
// The compare endpoint names at most this many files whatever the diff holds, and has no later page of them.
const COMPARE_FILE_CAP = 300
const SHA_PATTERN = /^[0-9a-f]{40}$/

/** What a read of the index repo needs. */
export interface GitHub {
  repo: string
  token: string
  fetch: FetchLike
}

function headers(gh: GitHub, accept: string): Record<string, string> {
  return { accept, authorization: `Bearer ${gh.token}`, 'x-github-api-version': '2022-11-28', 'user-agent': 'cc-cockpit-marketplace' }
}

/**
 * All pages of a list. Paged by number and not by following the Link header, so the token only ever
 * goes to a URL built here. A short page is the last one.
 */
export async function listAll(gh: GitHub, path: string): Promise<unknown[]> {
  const all: unknown[] = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const sep = path.includes('?') ? '&' : '?'
    const res = await gh.fetch(`${API_BASE}/repos/${gh.repo}${path}${sep}per_page=${PER_PAGE}&page=${page}`, {
      headers: headers(gh, 'application/vnd.github+json')
    })
    if (!res.ok) throw new ToolError(`auto-merge: GET ${path} answered ${res.status}`)
    const items = await res.json()
    if (!Array.isArray(items)) throw new ToolError(`auto-merge: GET ${path} did not answer a list`)
    all.push(...items)
    if (items.length < PER_PAGE) return all
  }
  // Deciding from a truncated list could miss a second file: refuse rather than guess.
  throw new ToolError(`auto-merge: GET ${path} has more than ${MAX_PAGES} pages`)
}

/** A file's text at `ref`, null when it is not there. */
async function fileAt(gh: GitHub, path: string, ref: string): Promise<string | null> {
  const encoded = path.split('/').map(encodeURIComponent).join('/')
  const res = await gh.fetch(`${API_BASE}/repos/${gh.repo}/contents/${encoded}?ref=${encodeURIComponent(ref)}`, {
    headers: headers(gh, 'application/vnd.github.raw+json')
  })
  if (res.status === 404) return null
  if (!res.ok) throw new ToolError(`auto-merge: GET contents answered ${res.status}`)
  return res.text()
}

async function openPulls(gh: GitHub): Promise<PullSummary[]> {
  const raw = await listAll(gh, `/pulls?state=open&base=${DEFAULT_BRANCH}`)
  return raw.flatMap((item) => toPullSummary(item) ?? [])
}

/** The commit main is at now. Everything read from main afterwards is read at this commit. */
async function mainCommit(gh: GitHub): Promise<string> {
  const res = await gh.fetch(`${API_BASE}/repos/${gh.repo}/git/ref/heads/${DEFAULT_BRANCH}`, {
    headers: headers(gh, 'application/vnd.github+json')
  })
  if (!res.ok) throw new ToolError(`auto-merge: GET the ${DEFAULT_BRANCH} ref answered ${res.status}`)
  const body = await res.json()
  const sha = isPlainObject(body) && isPlainObject(body.object) ? body.object.sha : undefined
  if (typeof sha !== 'string' || !SHA_PATTERN.test(sha)) throw new ToolError(`auto-merge: the ${DEFAULT_BRANCH} ref has no commit`)
  return sha
}

/**
 * What `head` changes since it left `base`, both fixed commits. Not `/pulls/N/files`: that answers for
 * wherever the branch is now, while the merge is pinned to `head`. A force-push A->B->A could then have
 * B's clean list authorize A's changes to tools/, which run with the publish credentials.
 *
 * Null when the answer may be partial (a human then): the endpoint caps the files at 300, and with more
 * commits than one page holds the answer is paged and only the first page has files.
 */
async function comparedFiles(gh: GitHub, base: string, head: string): Promise<PullFile[] | null> {
  // A sha or nothing: a branch name here would bring back the very race this function exists to close.
  if (!SHA_PATTERN.test(head)) throw new ToolError('auto-merge: the head is not a full commit hash')
  const res = await gh.fetch(`${API_BASE}/repos/${gh.repo}/compare/${base}...${head}`, {
    headers: headers(gh, 'application/vnd.github+json')
  })
  if (!res.ok) throw new ToolError(`auto-merge: GET compare answered ${res.status}`)
  const body = await res.json()
  if (!isPlainObject(body) || !Array.isArray(body.files) || !Array.isArray(body.commits)) {
    throw new ToolError('auto-merge: GET compare did not answer a comparison')
  }
  if (body.files.length >= COMPARE_FILE_CAP || body.total_commits !== body.commits.length) return null
  // A row that does not parse still counts as a file: it must not turn two files into one.
  return body.files.map((item: unknown) => {
    const row = isPlainObject(item) ? item : {}
    return { filename: String(row.filename), status: String(row.status) }
  })
}

function toPullSummary(raw: unknown): PullSummary | null {
  if (!isPlainObject(raw) || !isPlainObject(raw.user) || !isPlainObject(raw.head) || !isPlainObject(raw.base)) return null
  const { number, draft } = raw
  const authorId = raw.user.id
  const headSha = raw.head.sha
  const baseRef = raw.base.ref
  if (typeof number !== 'number' || typeof authorId !== 'number' || typeof headSha !== 'string' || typeof baseRef !== 'string') return null
  const repo = raw.head.repo
  const headRepo = isPlainObject(repo) && typeof repo.full_name === 'string' ? repo.full_name : null
  return { number, draft: draft === true, authorId, headSha, headRepo, baseRef }
}

export type RunResult = Decision & { number?: number; headEntryText?: string; base?: string }

/** Resolve the PR and decide. Separate from `main` so a test can drive it with a fake fetch. */
export async function run(gh: GitHub, headSha: string, headRepo: string): Promise<RunResult> {
  const pr = resolvePullRequest(await openPulls(gh), headSha, headRepo)
  if (pr === null) return no('no single open PR has this head commit')
  const base = await mainCommit(gh)
  const files = await comparedFiles(gh, base, pr.headSha)
  if (files === null) return no('the comparison with main is too large to read whole')
  const id = bumpedId(files)
  const path = id === null ? null : `plugins/${id}.json`
  const mainEntryText = path === null ? null : await fileAt(gh, path, base)
  // By commit, not by branch name: the branch may already have moved, and the merge is pinned to this commit.
  const headEntryText = path === null ? null : await fileAt(gh, path, pr.headSha)
  const revokedText = path === null ? null : await fileAt(gh, 'revoked.json', base)
  const decision = decideAutoMerge({ pr, files, mainEntryText, headEntryText, revokedText })
  return decision.merge ? { ...decision, number: pr.number, headEntryText: headEntryText as string, base } : decision
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]
  if (value === undefined || value === '') throw new ToolError(`auto-merge: ${name} is not set`)
  return value
}

/**
 * Env: GH_TOKEN, GITHUB_REPOSITORY, GITHUB_OUTPUT, HEAD_SHA, HEAD_REPO (the last two from the
 * workflow_run event) and ENTRY_FILE, where the PR's entry goes for the token-free re-check.
 */
export async function main(_argv: string[], env: NodeJS.ProcessEnv = process.env, fetchFn: FetchLike = fetch): Promise<void> {
  const gh: GitHub = { repo: required(env, 'GITHUB_REPOSITORY'), token: required(env, 'GH_TOKEN'), fetch: fetchFn }
  const output = required(env, 'GITHUB_OUTPUT')
  const result = await run(gh, required(env, 'HEAD_SHA'), required(env, 'HEAD_REPO'))
  if (!result.merge) {
    console.log(`auto-merge: left for a human: ${result.reason}`)
    appendFileSync(output, 'merge=false\n')
    return
  }
  writeFileSync(required(env, 'ENTRY_FILE'), result.headEntryText as string)
  console.log(`auto-merge: PR ${String(result.number)} is a routine bump of ${result.id}`)
  // `base`: ownership and revocations were read at this commit; the Merge step refuses if main has left it.
  appendFileSync(output, `merge=true\nnumber=${String(result.number)}\nbase=${result.base as string}\n`)
}
