// plugins/*.json + revoked.json -> index.json. Usage:
//   build-index --root <repo> --out <file> [--index-url <url>] [--base <checkout>]
//
// A bad entry on main must not hold the revocation channel hostage: it can get there through a PR
// race, an admin bypass or a validator grown stricter, and a new row in revoked.json still has to
// reach users. So a bad entry keeps the listing main last published (it stays neither unlisted nor
// changed) or, with none, stays out; the index is written all the same, and the tool exits with
// PARTIAL_EXIT so the run shows red and somebody looks. A bad or missing revoked.json is the one thing
// that writes nothing: publishing without it would re-enable every revoked commit.
//
// The same holds for a PR's check: a bad entry on main must not hold up a PR that only revokes something.
// `--base` (check.yml) names the PR's base checkout: a bad entry identical there is reported and does
// not fail the run, a new or changed one does.
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_MARKETPLACE_URL,
  MARKETPLACE_SCHEMA,
  MAX_INDEX_BYTES,
  parseMarketplaceIndex,
  type MarketplaceEntry
} from '../../../src/shared/marketplace'
import {
  MAX_ENTRY_BYTES,
  ToolError,
  entryPath,
  listEntryFiles,
  parseFlags,
  parseRevoked,
  parseSourceEntry,
  quoted,
  readRegularFile,
  sameEntryFile
} from './common'

// The index cap: the revocations go into the same file.
const MAX_REVOKED_BYTES = MAX_INDEX_BYTES

/** Exit code: `--out` was written, but problems were found. publish-index.yml pushes, then fails. */
export const PARTIAL_EXIT = 2

export interface BuiltIndex {
  /** The text of `index.json`. */
  text: string
  /** One line per entry that could not be used, empty for a clean build. */
  problems: string[]
  /** The same, for entries identical in the base checkout: not this change's doing. Empty with no base. */
  inherited: string[]
}

/** The listings of the `index.json` already at `root`; none when it is absent or not usable. */
function publishedEntries(root: string, indexUrl: string): MarketplaceEntry[] {
  const file = join(root, 'index.json')
  if (!existsSync(file)) return []
  try {
    const parsed = parseMarketplaceIndex(readRegularFile(file, MAX_INDEX_BYTES), { indexUrl })
    return parsed.ok ? parsed.index.plugins : []
  } catch {
    return []
  }
}

/**
 * The index for the repo at `root`. Throws a ToolError when no safe index can be written at all.
 * `base` is the checkout whose bad entries are `inherited`, not `problems`.
 */
export function buildIndex(root: string, indexUrl: string = DEFAULT_MARKETPLACE_URL, base?: string): BuiltIndex {
  // First and fatal: nothing below may publish without it. A missing file fails too, since treating
  // it as "no revocations" would re-enable every revoked commit.
  const revoked = parseRevoked(readRegularFile(join(root, 'revoked.json'), MAX_REVOKED_BYTES))
  if (!revoked.ok) throw new ToolError(`build-index: ${revoked.problem}`)

  const problems: string[] = []
  const inherited: string[] = []
  const plugins: MarketplaceEntry[] = []
  const published = publishedEntries(root, indexUrl)
  for (const name of listEntryFiles(join(root, 'plugins'))) {
    const label = `plugins/${quoted(name)}`
    const refuse = (problem: string): void => {
      const previous = published.find((e) => `${e.id}.json` === name)
      const line = `build-index: ${label}: ${problem} (${previous ? 'the published listing stays' : 'not listed'})`
      if (base !== undefined && sameEntryFile(base, root, name)) inherited.push(line)
      else problems.push(line)
      if (previous) plugins.push(previous)
    }
    let text: string
    try {
      text = readRegularFile(entryPath(root, name), MAX_ENTRY_BYTES)
    } catch (err) {
      refuse(err instanceof Error ? err.message : String(err))
      continue
    }
    const parsed = parseSourceEntry(text, indexUrl)
    if (!parsed.ok) refuse(parsed.problem)
    // The auto-merge rule "filename equals the id" and the one-listing-per-id rule both rest on this.
    else if (name !== `${parsed.entry.id}.json`) refuse('the file name must be the id plus .json')
    // Only the validated fields go on, so `owners` never reaches the published file.
    else plugins.push(parsed.entry)
  }

  const text = `${JSON.stringify({ schema: MARKETPLACE_SCHEMA, plugins, revoked: revoked.revoked }, null, 2)}\n`
  // The whole index through the app's parser once more: its caps are the app's, and an index it
  // would refuse must never replace one it accepts.
  if (Buffer.byteLength(text) > MAX_INDEX_BYTES) throw new ToolError('build-index: the index is over the size cap')
  const check = parseMarketplaceIndex(text, { indexUrl })
  if (!check.ok) throw new ToolError(`build-index: ${check.error}`)
  return { text, problems, inherited }
}

export async function main(argv: string[]): Promise<void> {
  const flags = parseFlags(argv, ['--root', '--out', '--index-url', '--base'])
  const root = flags.get('--root')
  const out = flags.get('--out')
  if (root === undefined || out === undefined) throw new ToolError('usage: build-index --root <repo> --out <file> [--index-url <url>] [--base <checkout>]')
  const built = buildIndex(root, flags.get('--index-url'), flags.get('--base'))
  writeFileSync(out, built.text)
  // In the log for whoever looks, and still red on main's own publish run, which passes no base.
  if (built.inherited.length > 0) console.error(built.inherited.map((line) => `already on the base, not failing: ${line}`).join('\n'))
  if (built.problems.length > 0) {
    console.error(built.problems.join('\n'))
    process.exitCode = PARTIAL_EXIT
  }
}
