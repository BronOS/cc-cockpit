// What the index repo's CI tools share: reading the source files of the index. Every byte under
// plugins/ can come from a PR, so it is parsed as untrusted and anything echoed into a log goes
// through `quoted`: GitHub reads a log line starting with `::` as a workflow command, and JSON keeps
// a value on one line behind the tool's own prefix.
import { constants as fsConstants, existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs'
import { join } from 'node:path'
import { isPlainObject } from '../../../src/shared/guards'
import {
  MAX_INDEX_REVOCATIONS,
  parseEntry,
  parseRevocation,
  type MarketplaceEntry,
  type MarketplaceRevocation
} from '../../../src/shared/marketplace'

/** A source file holds one small record; a real one is well under 2 KiB. */
export const MAX_ENTRY_BYTES = 64 * 1024
/** Who may auto-merge a plugin's updates: a handful in practice; the cap bounds what one file makes CI compare. */
export const MAX_OWNERS = 50

/** The fields of `plugins/<id>.json`. Unknown ones are refused: a typo must not read as "not set". */
const ENTRY_FIELDS = new Set(['id', 'name', 'description', 'author', 'repo', 'version', 'tag', 'commit', 'api', 'owners'])

/** A refusal meant for the log, printed without a stack. */
export class ToolError extends Error {}

// plugin.json may be 256 KB of somebody else's text, and the log is public.
const MAX_QUOTED = 200

export function quoted(value: unknown): string {
  const text = JSON.stringify(value) ?? 'undefined'
  return text.length > MAX_QUOTED ? `${text.slice(0, MAX_QUOTED)}…` : text
}

export interface SourceEntry {
  /** The validated fields, exactly what goes into `index.json`. */
  entry: MarketplaceEntry
  owners: number[]
  /** The parsed file as written, for comparing two versions field by field. */
  raw: Record<string, unknown>
}

export type ParsedSource = ({ ok: true } & SourceEntry) | { ok: false; problem: string }

/** Parse the text of a source file through the validator the app itself runs. Never throws. */
export function parseSourceEntry(text: string, indexUrl: string): ParsedSource {
  if (text.length > MAX_ENTRY_BYTES) return { ok: false, problem: 'the file is too large' }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, problem: 'the file is not valid JSON' }
  }
  if (!isPlainObject(raw)) return { ok: false, problem: 'the file is not a JSON object' }
  const unknown = Object.keys(raw).filter((key) => !ENTRY_FIELDS.has(key))
  if (unknown.length > 0) return { ok: false, problem: `unknown fields: ${quoted(unknown)}` }
  const { owners, ...fields } = raw
  // Numeric ids and not logins: a login can be given up and registered again by somebody else.
  if (
    !Array.isArray(owners) ||
    owners.length === 0 ||
    owners.length > MAX_OWNERS ||
    !owners.every((o) => Number.isSafeInteger(o) && (o as number) > 0)
  ) {
    return { ok: false, problem: `"owners" must list 1 to ${MAX_OWNERS} numeric GitHub user ids` }
  }
  const parsed = parseEntry(fields, indexUrl)
  if (!parsed.ok) return parsed
  return { ok: true, entry: parsed.entry, owners: owners as number[], raw }
}

/** Parse `revoked.json` (a list of revocations). One bad row refuses the file. */
export function parseRevoked(text: string): { ok: true; revoked: MarketplaceRevocation[] } | { ok: false; problem: string } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, problem: 'revoked.json is not valid JSON' }
  }
  if (!Array.isArray(raw)) return { ok: false, problem: 'revoked.json is not a list' }
  if (raw.length > MAX_INDEX_REVOCATIONS) return { ok: false, problem: `revoked.json: more than ${MAX_INDEX_REVOCATIONS} revocations` }
  const revoked: MarketplaceRevocation[] = []
  for (const [i, row] of raw.entries()) {
    const parsed = parseRevocation(row)
    if (!parsed.ok) return { ok: false, problem: `revoked.json has an invalid row (${i + 1}): ${parsed.problem}` }
    revoked.push(parsed.revocation)
  }
  return { ok: true, revoked }
}

/**
 * The text of a regular file, at most `maxBytes`. A symlink is refused: a PR can add one, and
 * following it would feed some file of the runner into the tool.
 */
export function readRegularFile(path: string, maxBytes: number): string {
  const stats = lstatSync(path)
  if (!stats.isFile()) throw new ToolError(`${quoted(path)} is not a regular file`)
  if (stats.size > maxBytes) throw new ToolError(`${quoted(path)} is too large`)
  return readFileSync(path, 'utf8')
}

/**
 * The `*.json` names in `plugins/`, in code-unit order so a build is the same on every machine. No
 * folder means no entries: git keeps no empty one, so a PR removing the last entry and its `.gitkeep`
 * gets here, and a crash would also stop revocations from publishing.
 */
export function listEntryFiles(pluginsDir: string): string[] {
  if (!existsSync(pluginsDir)) return []
  return readdirSync(pluginsDir)
    .filter((name) => name.endsWith('.json'))
    .sort()
}

export function entryPath(root: string, name: string): string {
  return join(root, 'plugins', name)
}

/**
 * The same entry path holds the same thing in both checkouts. Compares what git tracks without judging
 * it, so a file the tools refuse to read (a symlink, one over the size cap) is comparable too: otherwise
 * one bad file on main would stop every PR, and a PR could not be told from main by a thrown error.
 */
export function sameEntryFile(base: string, head: string, name: string): boolean {
  const basePath = entryPath(base, name)
  const headPath = entryPath(head, name)
  const before = lstatSync(basePath, { throwIfNoEntry: false })
  const after = lstatSync(headPath, { throwIfNoEntry: false })
  if (!before || !after || (before.mode & fsConstants.S_IFMT) !== (after.mode & fsConstants.S_IFMT)) return false
  if (after.isSymbolicLink()) return readlinkSync(basePath) === readlinkSync(headPath)
  if (after.isFile()) return before.size === after.size && readFileSync(basePath).equals(readFileSync(headPath))
  return true
}

/** `--flag value` pairs; anything else is a usage error. */
export function parseFlags(argv: string[], allowed: readonly string[]): Map<string, string> {
  const flags = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i]!
    const value = argv[i + 1]
    if (!allowed.includes(name) || value === undefined) throw new ToolError(`usage: ${allowed.map((a) => `${a} <value>`).join(' ')}`)
    flags.set(name, value)
  }
  return flags
}

/** The command-line wrapper: a ToolError is a plain message, anything else is a bug and keeps its stack. */
export function runCli(main: (argv: string[]) => Promise<void>): void {
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(err instanceof ToolError ? err.message : err)
    process.exitCode = 1
  })
}
