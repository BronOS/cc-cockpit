// Marketplace index format and validator (plan: plugin marketplace, Task 1).
//
// The index is a static JSON file anyone can host, so every byte of it is untrusted. Pure module
// (no Electron, no Node imports): main uses it to validate a fetch, and the index repo's CI bundles
// it so a PR is checked by the very code the app runs.
//
// Policy: a bad body or an unknown `schema` refuses the whole index (the caller keeps its last good
// cache); a bad entry or revocation is dropped and counted, so one typo does not hide the rest and
// the user still sees that something was skipped.
import { gitTagProblem, gitUrlProblem } from './git-source'
import { isPlainObject } from './guards'
import {
  PLUGIN_ID_MAX_LENGTH,
  PLUGIN_ID_PATTERN,
  PLUGIN_VERSION_PATTERN,
  RESERVED_PLUGIN_ID_MESSAGE,
  isReservedPluginId,
} from './manifest'

/** The official index. Its revocations are enforced on every plugin, wherever it came from. */
export const DEFAULT_MARKETPLACE_URL = 'https://raw.githubusercontent.com/BronOS/cc-cockpit-marketplace/main/index.json'
export const MARKETPLACE_SCHEMA = 1
/** An index older than this is fetched again (main's timer, the Marketplace page). */
export const STALE_AFTER_MS = 60 * 60_000
export const MAX_INDEX_BYTES = 5 * 1024 * 1024
/** The refusal for an index past MAX_INDEX_BYTES, whether the fetch or the parser notices first. */
export const INDEX_TOO_LARGE = 'the index is too large'
export const MAX_INDEX_PLUGINS = 2000
export const MAX_INDEX_REVOCATIONS = 2000
export const MAX_NAME_LENGTH = 100
export const MAX_AUTHOR_LENGTH = 100
export const MAX_DESCRIPTION_LENGTH = 1000
export const MAX_REASON_LENGTH = 1000
export const MAX_VERSION_LENGTH = 64
// A full sha-1 object name. A short or uppercase form could match several objects or compare
// unequal to what `git rev-parse` prints, so only the one canonical spelling is accepted.
export const COMMIT_PATTERN = /^[0-9a-f]{40}$/

export interface MarketplaceEntry {
  id: string
  name: string
  description: string
  author: string
  repo: string
  version: string
  tag: string
  commit: string
  api: number
}

export interface MarketplaceRevocation {
  id: string
  commit: string
  reason: string
}

export interface MarketplaceIndex {
  schema: number
  plugins: MarketplaceEntry[]
  revoked: MarketplaceRevocation[]
}

export type ParsedMarketplace =
  | {
      ok: true
      index: MarketplaceIndex
      skippedEntries: number
      skippedRevocations: number
    }
  | { ok: false; error: string }

// Control (incl. DEL, C1), line separator and bidi format characters: a right-to-left override in a
// name or author would let a listing spoof another one, and a newline in a notification can fake a
// second line of text. React escaping stops neither.
// eslint-disable-next-line no-control-regex
const UNSAFE_TEXT = /[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/
const UNSAFE_TEXT_ALL = new RegExp(UNSAFE_TEXT.source, 'g')

/**
 * Index text made safe for a surface that is not React: unsafe characters become spaces, whitespace
 * collapses, `<` and `>` go (a Linux notification daemon may render a body as markup, links
 * included), and the result is capped.
 */
export function plainDisplayText(text: string, max: number): string {
  const clean = text.replace(UNSAFE_TEXT_ALL, ' ').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

/** A display label: bounded, not blank, no control or bidi characters. */
function label(v: unknown, max: number): v is string {
  return boundedString(v, max) && v.trim() !== '' && !UNSAFE_TEXT.test(v)
}

function boundedString(
  v: unknown,
  max: number,
  allowEmpty = false,
): v is string {
  return typeof v === 'string' && v.length <= max && (allowEmpty || v !== '')
}

/**
 * Why `repo` may not be listed by an index fetched from `indexUrl`, or null. Beyond
 * `gitUrlProblem`: `git@` is refused (it would make the app use the user's ssh agent on a host the
 * index chose), and a `file:` repo needs a `file:` index (a remote index must not point git at
 * local paths).
 */
export function marketplaceRepoProblem(
  repo: unknown,
  indexUrl: string,
): string | null {
  const problem = gitUrlProblem(repo)
  if (problem !== null) return problem
  const url = repo as string
  if (url.startsWith('git@'))
    return 'an ssh repo is not allowed in a marketplace'
  if (url.startsWith('file://') && !indexUrl.startsWith('file:'))
    return 'a file: repo needs a file: index'
  // The confirmation shows this string and the user judges the host by it: a non-ASCII look-alike
  // (IDN homograph, Cyrillic "а" in "github") must not read as the real one. Punycode stays allowed,
  // since `xn--` is visibly not the name it imitates.
  if (!/^[\x21-\x7e]+$/.test(url))
    return 'the repo URL must be plain ASCII (write an international host as xn--)'
  return null
}

/**
 * One entry, or what is wrong with it. The problem names a field and never echoes its value, so the
 * index repo's CI can print it to an author as is.
 */
export function parseEntry(
  raw: unknown,
  indexUrl: string,
): { ok: true; entry: MarketplaceEntry } | { ok: false; problem: string } {
  const bad = (problem: string) => ({ ok: false as const, problem })
  if (!isPlainObject(raw)) return bad('the entry is not a JSON object')
  const { id, name, description, author, repo, version, tag, commit, api } =
    raw
  if (
    typeof id !== 'string' ||
    id.length > PLUGIN_ID_MAX_LENGTH ||
    !PLUGIN_ID_PATTERN.test(id)
  )
    return bad('"id" is not a valid plugin id')
  // The app ships these itself; a listing could only ever be refused at install. Dropped here so the
  // index tools refuse the PR and the Marketplace page never offers one.
  if (isReservedPluginId(id)) return bad(`"id": ${RESERVED_PLUGIN_ID_MESSAGE}`)
  if (!label(name, MAX_NAME_LENGTH))
    return bad(
      `"name" must be 1 to ${MAX_NAME_LENGTH} characters, not blank, with no control or bidi characters`,
    )
  // Line breaks are fine in prose, and the page renders the text as text.
  if (
    !boundedString(description, MAX_DESCRIPTION_LENGTH, true) ||
    UNSAFE_TEXT.test(description.replaceAll('\n', ''))
  )
    return bad(
      `"description" must be at most ${MAX_DESCRIPTION_LENGTH} characters, with no control or bidi characters`,
    )
  if (!label(author, MAX_AUTHOR_LENGTH))
    return bad(
      `"author" must be 1 to ${MAX_AUTHOR_LENGTH} characters, not blank, with no control or bidi characters`,
    )
  const repoProblem = marketplaceRepoProblem(repo, indexUrl)
  if (repoProblem !== null) return bad(`"repo": ${repoProblem}`)
  if (
    typeof version !== 'string' ||
    version.length > MAX_VERSION_LENGTH ||
    !PLUGIN_VERSION_PATTERN.test(version)
  )
    return bad('"version" is not a valid plugin version')
  const tagProblem = gitTagProblem(tag)
  if (tagProblem !== null) return bad(`"tag": ${tagProblem}`)
  if (typeof commit !== 'string' || !COMMIT_PATTERN.test(commit))
    return bad('"commit" must be the full 40-character lower-case hash')
  if (typeof api !== 'number' || !Number.isInteger(api) || api < 1)
    return bad('"api" must be a positive integer')
  return {
    ok: true,
    entry: {
      id,
      name,
      description,
      author,
      repo: repo as string,
      version,
      tag: tag as string,
      commit,
      api,
    },
  }
}

/**
 * One revocation, or what is wrong with it. An unsafe character in `reason` is cleaned, not refused:
 * dropping the row over its prose would silently re-enable the bad commit.
 */
export function parseRevocation(
  raw: unknown,
): { ok: true; revocation: MarketplaceRevocation } | { ok: false; problem: string } {
  const bad = (problem: string) => ({ ok: false as const, problem })
  if (!isPlainObject(raw)) return bad('the row is not a JSON object')
  const { id, commit, reason } = raw
  if (
    typeof id !== 'string' ||
    id.length > PLUGIN_ID_MAX_LENGTH ||
    !PLUGIN_ID_PATTERN.test(id)
  )
    return bad('"id" is not a valid plugin id')
  if (typeof commit !== 'string' || !COMMIT_PATTERN.test(commit))
    return bad('"commit" must be the full 40-character lower-case hash')
  if (!boundedString(reason, MAX_REASON_LENGTH, true))
    return bad(`"reason" must be a text of at most ${MAX_REASON_LENGTH} characters`)
  return {
    ok: true,
    revocation: { id, commit, reason: reason.replace(UNSAFE_TEXT_ALL, ' ') },
  }
}

// Only a number is echoed: the value is untrusted and an unbounded string would travel into
// whatever shows or logs the fetch error.
function describeSchema(v: unknown): string {
  if (v === undefined) return 'missing'
  return typeof v === 'number' ? String(v) : `of type ${typeof v}`
}

/** Validate the text of an index fetched from `indexUrl`. Never throws. */
export function parseMarketplaceIndex(
  text: string,
  opts: { indexUrl: string },
): ParsedMarketplace {
  // UTF-16 length is a lower bound of the byte size; the fetcher enforces the byte cap while
  // reading, this is the backstop for a caller that did not.
  if (text.length > MAX_INDEX_BYTES)
    return { ok: false, error: INDEX_TOO_LARGE }
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return { ok: false, error: 'the index is not valid JSON' }
  }
  if (!isPlainObject(data))
    return { ok: false, error: 'the index is not a JSON object' }
  if (data.schema !== MARKETPLACE_SCHEMA) {
    return {
      ok: false,
      error: `unsupported index schema ${describeSchema(data.schema)}`,
    }
  }
  if (!Array.isArray(data.plugins))
    return { ok: false, error: 'the index has no "plugins" list' }
  // Only a missing field means "no revocations"; null is a malformed body, not an empty list.
  const rawRevoked: unknown = data.revoked === undefined ? [] : data.revoked
  if (!Array.isArray(rawRevoked))
    return { ok: false, error: 'the "revoked" field is not a list' }
  if (data.plugins.length > MAX_INDEX_PLUGINS)
    return { ok: false, error: `more than ${MAX_INDEX_PLUGINS} plugins` }
  if (rawRevoked.length > MAX_INDEX_REVOCATIONS) {
    return {
      ok: false,
      error: `more than ${MAX_INDEX_REVOCATIONS} revocations`,
    }
  }

  const valid: MarketplaceEntry[] = []
  let skippedEntries = 0
  // A duplicate id is ambiguous (which one is the real listing?), so none of them is trusted.
  // Counted over the raw entries: a malformed twin must not leave the valid one listed.
  const counts = new Map<string, number>()
  for (const raw of data.plugins) {
    if (isPlainObject(raw) && typeof raw.id === 'string')
      counts.set(raw.id, (counts.get(raw.id) ?? 0) + 1)
  }
  for (const raw of data.plugins) {
    const parsed = parseEntry(raw, opts.indexUrl)
    if (parsed.ok) valid.push(parsed.entry)
    else skippedEntries++
  }
  const plugins = valid.filter((e) => counts.get(e.id) === 1)
  skippedEntries += valid.length - plugins.length

  const revoked: MarketplaceRevocation[] = []
  let skippedRevocations = 0
  for (const raw of rawRevoked) {
    const parsed = parseRevocation(raw)
    if (parsed.ok) revoked.push(parsed.revocation)
    else skippedRevocations++
  }
  return {
    ok: true,
    index: { schema: MARKETPLACE_SCHEMA, plugins, revoked },
    skippedEntries,
    skippedRevocations,
  }
}

/**
 * Two digit strings by value, without Number: past 2^53 distinct strings would be equal or swap
 * order, and '01' and '1' must not order both ways. Strip leading zeros, then length, then text.
 */
function compareDigits(p: string, q: string): number {
  const a = p.replace(/^0+(?=\d)/, '')
  const b = q.replace(/^0+(?=\d)/, '')
  if (a === b) return 0
  return a.length !== b.length ? (a.length < b.length ? -1 : 1) : a < b ? -1 : 1
}

/**
 * Semver precedence of two versions the manifest pattern accepted: -1, 0 or 1. Build metadata is
 * ignored; a version with a pre-release sorts below the same one without; pre-release identifiers
 * compare numerically when both are numbers, a number below text, a shorter list below a longer one.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): { nums: string[]; pre: string[] } => {
    const [core = '', pre] = v.split('+')[0]!.split(/-(.*)/s)
    return { nums: core.split('.'), pre: pre === undefined || pre === '' ? [] : pre.split('.') }
  }
  const x = parse(a)
  const y = parse(b)
  for (let i = 0; i < 3; i++) {
    // As strings: the manifest pattern has no size limit, and through Number 9007199254740992.1.0
    // read as newer than 9007199254740993.0.0, a downgrade offered as an update (review finding).
    const p = x.nums[i] || '0'
    const q = y.nums[i] || '0'
    // Malformed input fails towards "not newer", never towards offering an update.
    if (!/^\d+$/.test(p) || !/^\d+$/.test(q)) return 0
    const d = compareDigits(p, q)
    if (d !== 0) return d
  }
  if (x.pre.length === 0 || y.pre.length === 0) {
    return x.pre.length === y.pre.length ? 0 : x.pre.length === 0 ? 1 : -1
  }
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i]
    const q = y.pre[i]
    if (p === undefined) return -1
    if (q === undefined) return 1
    if (p === q) continue
    const pn = /^\d+$/.test(p)
    const qn = /^\d+$/.test(q)
    if (pn && qn) {
      const d = compareDigits(p, q)
      if (d === 0) continue
      return d
    }
    if (pn !== qn) return pn ? -1 : 1
    return p < q ? -1 : 1
  }
  return 0
}
