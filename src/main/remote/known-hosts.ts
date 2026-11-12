// Host key fingerprints and a read-only `~/.ssh/known_hosts` lookup (design-remote-desktop.md §5.3).
// The built-in client trusts a host the person's own `ssh` already trusts, refuses one whose key
// changed, and asks about the rest; it never writes known_hosts (the record's `hostKey` is ours).
//
// Only the entry forms that say exactly one thing about exactly one host are read:
//  - plain host lists (`devbox,10.0.0.5 ssh-ed25519 AAAA...`), compared case-insensitively;
//  - hashed entries (`|1|<salt>|<hash>`: HMAC-SHA1 keyed by the salt over the host name), the default
//    on many distributions (`HashKnownHosts yes`);
//  - the `[host]:port` form for a port other than 22, exactly as ssh writes it.
// Ignored, so such a host is "unknown" and the person is asked (asking is the safe side of a doubt):
// wildcard patterns (`*.corp`), any line with a negated pattern (`!` excludes hosts from a line, and
// half-reading it could trust a host the line excludes), `@cert-authority` (no certificate support)
// and unknown markers. `@revoked` lines are the exception: they are matched by key alone, whatever
// their host field says, because a revoked key is revoked for every host and those lines are usually
// written as `@revoked * ...`, a wildcard this reader would otherwise skip.
// No regexes (repo rule for parsers in main): fields are split by plain loops.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

/** A host's keys from known_hosts: by known_hosts type, in file order, and every `@revoked` key. */
export interface KnownHostKeys {
  /** Key type (`ssh-ed25519`, `ecdsa-sha2-nistp256`, `ssh-rsa`, ...) → key blobs listed for the host. */
  keys: Map<string, Buffer[]>
  /** Every `@revoked` key in the file, for any host. */
  revoked: Buffer[]
}

export type KnownHostVerdict =
  /** A line for the host lists this exact key. */
  | 'trusted'
  /** A line for the host lists a different key of the same type: refuse, never ask. */
  | 'changed'
  /** The key is marked `@revoked`: refuse, whatever else says. */
  | 'revoked'
  /** Nothing for the host with this type: ask the person. */
  | 'unknown'

/** `SHA256:` and the unpadded base64 of the key blob's SHA-256, exactly what `ssh-keygen -l` prints. */
export function fingerprint(keyBlob: Buffer): string {
  const b64 = createHash('sha256').update(keyBlob).digest('base64')
  let end = b64.length
  while (end > 0 && b64[end - 1] === '=') end--
  return `SHA256:${b64.slice(0, end)}`
}

/**
 * The key type a public key blob names in its first field (`string type, ...`), or null when the
 * blob is too short or the name is not printable ASCII. An RSA key's blob says `ssh-rsa` whatever
 * algorithm it signs with, which is also the type known_hosts lists it under.
 */
export function keyBlobType(keyBlob: Buffer): string | null {
  if (keyBlob.length < 4) return null
  const len = keyBlob.readUInt32BE(0)
  if (len === 0 || len > 64 || keyBlob.length < 4 + len) return null
  for (let i = 4; i < 4 + len; i++) {
    const c = keyBlob[i]!
    if (c <= 0x20 || c >= 0x7f) return null
  }
  return keyBlob.toString('latin1', 4, 4 + len)
}

/** The host field ssh writes and looks up: `host` on port 22, `[host]:port` on any other. */
export function knownHostName(hostName: string, port: number): string {
  const host = hostName.toLowerCase()
  return port === 22 ? host : `[${host}]:${port}`
}

/** Splits on runs of spaces and tabs (no regex). */
function fields(line: string): string[] {
  const out: string[] = []
  let i = 0
  while (i < line.length) {
    while (line[i] === ' ' || line[i] === '\t') i++
    const start = i
    while (i < line.length && line[i] !== ' ' && line[i] !== '\t') i++
    if (i > start) out.push(line.slice(start, i))
  }
  return out
}

/** Strict base64 (standard alphabet, padding only at the end): Node's decoder silently skips junk. */
function decodeBase64(s: string): Buffer | null {
  if (s.length === 0 || s.length % 4 !== 0) return null
  let pad = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c === 61) {
      pad++
      continue
    }
    if (pad > 0) return null
    const ok = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 47
    if (!ok) return null
  }
  if (pad > 2) return null
  return Buffer.from(s, 'base64')
}

/** `|1|salt|hash`: the HMAC-SHA1 of the host field, keyed by the salt, compared in constant time. */
function hashedEntryMatches(entry: string, name: string): boolean {
  // `|1|` then two base64 fields; anything else (another hash version, a malformed entry) never matches.
  if (!entry.startsWith('|1|')) return false
  const rest = entry.slice(3)
  const bar = rest.indexOf('|')
  if (bar <= 0 || rest.indexOf('|', bar + 1) !== -1) return false
  const salt = decodeBase64(rest.slice(0, bar))
  const hash = decodeBase64(rest.slice(bar + 1))
  if (salt === null || hash === null || salt.length !== 20 || hash.length !== 20) return false
  const mine = createHmac('sha1', salt).update(name).digest()
  return timingSafeEqual(mine, hash)
}

/** A plain comma list names the host exactly; a list with a negated pattern is not read at all. */
function plainListMatches(list: string, name: string): boolean {
  let matched = false
  for (const pattern of list.split(',')) {
    if (pattern.startsWith('!')) return false
    // A wildcard pattern never matches here (see the header); an exact one beside it still can.
    if (pattern.includes('*') || pattern.includes('?')) continue
    if (pattern.toLowerCase() === name) matched = true
  }
  return matched
}

/** One line's marker, host field, type and key blob; null for comments, blanks and lines not well formed. */
function parseLine(raw: string): { marker: string | null; hosts: string; type: string; blob: Buffer } | null {
  const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
  const f = fields(line)
  if (f.length === 0 || f[0]!.startsWith('#')) return null
  let marker: string | null = null
  if (f[0]!.startsWith('@')) marker = f.shift()!
  const [hosts, type, b64] = f
  if (hosts === undefined || type === undefined || b64 === undefined) return null
  const blob = decodeBase64(b64)
  // The blob names its own type: a line whose two disagree is corrupt and says nothing.
  if (blob === null || keyBlobType(blob) !== type) return null
  return { marker, hosts, type, blob }
}

/**
 * The keys known_hosts `text` lists for `hostName` (the resolved HostName, as ssh looks it up, not the
 * record's alias) on `port`, and every `@revoked` key.
 */
export function knownHostKeys(hostName: string, port: number, text: string): KnownHostKeys {
  const name = knownHostName(hostName, port)
  const keys = new Map<string, Buffer[]>()
  const revoked: Buffer[] = []
  for (const raw of text.split('\n')) {
    const entry = parseLine(raw)
    if (entry === null) continue
    if (entry.marker === '@revoked') {
      revoked.push(entry.blob)
      continue
    }
    // `@cert-authority` and any marker this reader does not know.
    if (entry.marker !== null) continue
    const matches = entry.hosts.startsWith('|') ? hashedEntryMatches(entry.hosts, name) : plainListMatches(entry.hosts, name)
    if (!matches) continue
    const list = keys.get(entry.type)
    if (list === undefined) keys.set(entry.type, [entry.blob])
    else if (!list.some((k) => k.equals(entry.blob))) list.push(entry.blob)
  }
  return { keys, revoked }
}

/**
 * The known_hosts key types listed for the host, in file order: put them first in the dial's
 * `preferredHostKeyTypes` (after the record's own key type, when it has one), so the server is asked
 * for a key this file can vouch for (§5.3). They are known_hosts types, not signature algorithms: an
 * RSA host is listed as `ssh-rsa`, and `ssh-client.ts`'s `hostKeyAlgorithmOps` turns that into
 * `rsa-sha2-512` / `rsa-sha2-256` (the SHA-1 `ssh-rsa` algorithm itself is never offered).
 */
export function knownHostKeyTypes(known: KnownHostKeys): string[] {
  return [...known.keys.keys()]
}

/**
 * The verdict on the key a server showed: revoked first (whatever else the file says), then an exact
 * match, then a different key of the same type for the host ("changed"; ssh's MITM warning), else
 * unknown. A key of another type than the listed ones is unknown, as in ssh: the host may have
 * several key types and the file only some of them.
 */
export function checkKnownHost(hostName: string, port: number, type: string, blob: Buffer, text: string): KnownHostVerdict {
  const known = knownHostKeys(hostName, port, text)
  if (known.revoked.some((k) => k.equals(blob))) return 'revoked'
  const listed = known.keys.get(type)
  if (listed === undefined) return 'unknown'
  return listed.some((k) => k.equals(blob)) ? 'trusted' : 'changed'
}
