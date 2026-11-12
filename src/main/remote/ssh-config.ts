// A small `~/.ssh/config` reader (design-remote-desktop.md §5.5): just enough of ssh_config(5) to dial a
// saved SSH server the way `ssh <host>` would, for the fields the record leaves empty. The record wins
// over everything here (the caller applies that); the config is re-read at each dial, so editing it
// needs no Edit in the app.
//
// What it reads, and why it stops there:
//  - `Host` blocks with `*`, `?` and `!` patterns, several per line; a negated pattern that matches
//    turns the whole block off (as in ssh: `Host * !bastion`). Matching is on the alias the person
//    typed, lowercased, as ssh does (never on the HostName).
//  - First value wins, as in ssh: a keyword set by an earlier matching line is never overwritten, so
//    the usual layout (specific blocks first, `Host *` defaults last) resolves the same way. A value we
//    cannot use (a `%` token, a relative path) still counts as the first one: taking a later value
//    instead would dial something `ssh` itself never would. `IdentityFile` is the one list (ssh tries
//    every one), in order.
//  - `Include` relative to `~/.ssh`, with globs (`*`, `?`) in any path part, depth 4 (ssh allows 16;
//    four covers every real layout, and with globs the fan-out grows with the depth), a file already
//    on the include chain refused (a loop), at most `MAX_FILES` files per resolve. An `Include` inside a
//    block that does not match is not read at all, which is what ssh's "never match" pass amounts to.
//  - `Match` blocks are skipped (their conditions need ssh's own state: exec, canonical, final) and
//    reported, so the picker can hint that the config may say more than we read.
//  - `ProxyJump` / `ProxyCommand` only set `jump`: the built-in client does not hop, and the caller
//    says "use My own tunnel" instead of dialling a host that is reachable only through the jump.
//  - Each file is capped at 256 KiB: a config is a few KiB; a bigger file is a mistake or a device, and
//    main must not parse it.
// No regexes (repo rule for every parser in main): the tokenizer and the wildcard matcher are plain
// loops, so a crafted config cannot cost main more than a linear scan.
import { open, readdir, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

/** Bytes per config file; a bigger one is skipped and named in `notes`. */
export const SSH_CONFIG_MAX_BYTES = 256 * 1024
/** Nested `Include` levels below `~/.ssh/config` (which is level 0). */
export const SSH_CONFIG_MAX_INCLUDE_DEPTH = 4
/** Files read per resolve, the main file included: bounds a glob fan-out over four levels. */
const MAX_FILES = 64
/** Paths one `Include` glob may expand to; more are dropped with a note. */
const MAX_GLOB_MATCHES = 64
/** `IdentityFile` entries kept; ssh's own limit is 100, a real config has a handful. */
const MAX_IDENTITY_FILES = 32

/** Where the agent comes from, from `IdentityAgent` (the caller resolves env names from `loginEnv`). */
export type SshIdentityAgent =
  /** `IdentityAgent none`: no agent at all. */
  | { kind: 'none' }
  /** `SSH_AUTH_SOCK` or `$NAME`: the socket path is that variable of the login environment. */
  | { kind: 'env'; name: string }
  /** A socket path, `~` expanded (1Password and Secretive set one). */
  | { kind: 'path'; path: string }

export interface SshConfigResult {
  /** `HostName`, `%h` and `%%` expanded; undefined when unset or unusable (dial the alias itself). */
  hostName?: string
  user?: string
  port?: number
  /** Absolute paths, `~` expanded, in config order, no duplicates; values with a `%` token are left out. */
  identityFiles: string[]
  identityAgent?: SshIdentityAgent
  /** A `ProxyJump` or `ProxyCommand` (other than `none`) applies: the built-in client cannot reach the host. */
  jump: boolean
  /** A `Match` block was skipped somewhere on the way: the config may set more than this says. */
  matchSkipped: boolean
  /** One plain line per thing not applied (a `%` token, a file over the cap, a deep or looping Include). */
  notes: string[]
}

export interface SshConfigOptions {
  /** The home directory: `~` and `~/.ssh` are resolved against it, never `os.homedir()` here. */
  home: string
  /** A file's text, or null when it does not exist or is not a regular file. */
  read: (path: string) => Promise<string | null>
  /** A directory's entry names (for `Include` globs), or null when it cannot be listed. */
  list: (dir: string) => Promise<string[] | null>
  /** The main file; defaults to `<home>/.ssh/config`. */
  path?: string
}

/** The real file system for `resolveSshConfig`: regular files only, at most the cap plus one byte read. */
export const nodeSshConfigFiles: Pick<SshConfigOptions, 'read' | 'list'> = {
  async read(path) {
    try {
      // `stat` before `open`: opening a FIFO for reading blocks until a writer appears, which would
      // hang a thread-pool thread for good. Symlinks are followed (dotfile managers link the config).
      if (!(await stat(path)).isFile()) return null
      const handle = await open(path, 'r')
      try {
        // One byte over the cap is enough to know it is over; the rest is never read.
        const buf = Buffer.alloc(SSH_CONFIG_MAX_BYTES + 1)
        let filled = 0
        while (filled < buf.length) {
          const { bytesRead } = await handle.read(buf, filled, buf.length - filled, filled)
          if (bytesRead === 0) break
          filled += bytesRead
        }
        return buf.subarray(0, filled).toString('utf8')
      } finally {
        await handle.close()
      }
    } catch {
      return null
    }
  },
  async list(dir) {
    try {
      return await readdir(dir)
    } catch {
      return null
    }
  }
}

/**
 * `*` and `?` wildcard match with no regex: the usual greedy scan that backtracks only to the last
 * `*`, so it is O(pattern × text) at worst. Case is the caller's business (hosts are lowercased first).
 */
export function wildcardMatch(pattern: string, text: string): boolean {
  let p = 0
  let t = 0
  let starP = -1
  let starT = 0
  while (t < text.length) {
    if (p < pattern.length && (pattern[p] === '?' || pattern[p] === text[t])) {
      p++
      t++
    } else if (p < pattern.length && pattern[p] === '*') {
      starP = p++
      starT = t
    } else if (starP !== -1) {
      p = starP + 1
      t = ++starT
    } else {
      return false
    }
  }
  while (p < pattern.length && pattern[p] === '*') p++
  return p === pattern.length
}

function hasWildcard(s: string): boolean {
  return s.includes('*') || s.includes('?')
}

function isBlank(c: string | undefined): boolean {
  return c === ' ' || c === '\t'
}

/**
 * Splits a line's arguments as ssh's `argv_split` does: blanks separate, `"` and `'` quote (quotes
 * removed), a backslash escapes a quote, a backslash or (outside quotes) a blank, and a `#` that
 * starts an argument ends the line. Null for an unterminated quote (ssh refuses the line too).
 */
export function splitConfigArgs(s: string): string[] | null {
  const args: string[] = []
  let i = 0
  while (i < s.length) {
    while (isBlank(s[i])) i++
    if (i >= s.length || s[i] === '#') break
    let arg = ''
    let quote = ''
    for (; i < s.length; i++) {
      const c = s[i]!
      if (quote === '' && isBlank(c)) break
      if (c === '\\') {
        const next = s[i + 1]
        if (next === '"' || next === "'" || next === '\\' || (quote === '' && next === ' ')) {
          arg += next
          i++
          continue
        }
        arg += c
      } else if (c === '"' || c === "'") {
        if (quote === '') quote = c
        else if (quote === c) quote = ''
        else arg += c
      } else {
        arg += c
      }
    }
    if (quote !== '') return null
    args.push(arg)
  }
  return args
}

/** The keyword (lowercased) and the rest of a line, for both `key value` and `key=value` forms. */
function splitKeyword(line: string): { keyword: string; rest: string } | null {
  let i = 0
  while (isBlank(line[i])) i++
  const start = i
  while (i < line.length && !isBlank(line[i]) && line[i] !== '=') i++
  if (i === start) return null
  const keyword = line.slice(start, i).toLowerCase()
  while (isBlank(line[i])) i++
  // One `=` may sit between the keyword and its value, blanks around it or not (`Port = 22`).
  if (line[i] === '=') {
    i++
    while (isBlank(line[i])) i++
  }
  return { keyword, rest: line.slice(i) }
}

/** ssh's `Host` rule: some positive pattern matches and no negated one does. */
export function hostPatternsMatch(patterns: readonly string[], host: string): boolean {
  const h = host.toLowerCase()
  let matched = false
  for (const raw of patterns) {
    const negated = raw.startsWith('!')
    const pattern = (negated ? raw.slice(1) : raw).toLowerCase()
    if (!wildcardMatch(pattern, h)) continue
    // A matching negation wins over every positive pattern on the line, before or after it.
    if (negated) return false
    matched = true
  }
  return matched
}

/** Context of one resolve: the first-wins bookkeeping and the caps, shared across included files. */
interface Run {
  host: string
  opts: SshConfigOptions
  sshDir: string
  result: SshConfigResult
  /** Keywords already given a value by a matching line (first wins), `proxy` for both jump forms. */
  seen: Set<string>
  filesRead: number
}

/** `~` and `~/x` expanded against home; `~user/...` and relative paths are not ours to guess (null). */
function expandTilde(value: string, home: string): string | null {
  if (value === '~') return home
  if (value.startsWith('~/')) return join(home, value.slice(2))
  if (value.startsWith('~')) return null
  return isAbsolute(value) ? value : null
}

/** Expands `*` / `?` in any part of an absolute path over `list`, sorted as glob(3) does; dot files only for a dot pattern. */
async function expandGlob(path: string, run: Run): Promise<string[]> {
  if (!hasWildcard(path)) return [path]
  let bases = ['/']
  for (const part of path.split('/')) {
    if (part === '') continue
    if (!hasWildcard(part)) {
      bases = bases.map((b) => join(b, part))
      continue
    }
    const next: string[] = []
    for (const base of bases) {
      const names = (await run.opts.list(base)) ?? []
      for (const name of names) {
        if (name.startsWith('.') && !part.startsWith('.')) continue
        if (wildcardMatch(part, name)) next.push(join(base, name))
      }
      if (next.length > MAX_GLOB_MATCHES) break
    }
    bases = next
    if (bases.length === 0) return []
  }
  bases.sort()
  if (bases.length > MAX_GLOB_MATCHES) {
    run.result.notes.push(`Include ${path} matches more than ${MAX_GLOB_MATCHES} files: the rest are ignored`)
    bases = bases.slice(0, MAX_GLOB_MATCHES)
  }
  return bases
}

function note(run: Run, text: string): void {
  // Bounded too: a config of 256 KiB could otherwise produce thousands of identical lines.
  if (run.result.notes.length < 32 && !run.result.notes.includes(text)) run.result.notes.push(text)
}

/** Takes the first value of a keyword; false when an earlier matching line already set it. */
function first(run: Run, key: string): boolean {
  if (run.seen.has(key)) return false
  run.seen.add(key)
  return true
}

/** `HostName` with `%h` (the alias) and `%%`; any other token makes it unusable (null). */
function expandHostName(value: string, host: string): string | null {
  let out = ''
  for (let i = 0; i < value.length; i++) {
    const c = value[i]
    if (c !== '%') {
      out += c
      continue
    }
    const t = value[i + 1]
    if (t === 'h') out += host
    else if (t === '%') out += '%'
    else return null
    i++
  }
  return out
}

function isEnvName(s: string): boolean {
  if (s.length === 0 || s.length > 128) return false
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    const letter = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95
    const digit = c >= 48 && c <= 57
    if (!letter && !(digit && i > 0)) return false
  }
  return true
}

function applyKeyword(run: Run, keyword: string, args: string[]): void {
  const { result, opts } = run
  const value = args[0]
  if (value === undefined) return
  switch (keyword) {
    case 'hostname': {
      if (!first(run, keyword)) return
      const name = expandHostName(value, run.host)
      if (name === null || name === '') note(run, `HostName ${value} uses a % token other than %h: ignored`)
      else result.hostName = name
      return
    }
    case 'user':
      if (!first(run, keyword)) return
      if (value.includes('%')) note(run, `User ${value} uses a % token: ignored`)
      else result.user = value
      return
    case 'port': {
      if (!first(run, keyword)) return
      // Digits only (ssh also takes service names; nobody writes `Port ssh`), no regex.
      let n = 0
      let ok = value.length > 0 && value.length <= 5
      for (const c of value) {
        if (c < '0' || c > '9') ok = false
        else n = n * 10 + (c.charCodeAt(0) - 48)
      }
      if (ok && n >= 1 && n <= 65535) result.port = n
      else note(run, `Port ${value} is not a port number: ignored`)
      return
    }
    case 'identityfile': {
      // Every matching line adds one (ssh tries them all); `%` tokens (%d, %u, %r, ...) are a cut of
      // this reader, so such a file is left out and named, not guessed at.
      if (value.includes('%')) return note(run, `IdentityFile ${value} uses a % token: ignored`)
      const path = expandTilde(value, opts.home)
      if (path === null) return note(run, `IdentityFile ${value} is not an absolute or ~/ path: ignored`)
      if (result.identityFiles.includes(path)) return
      if (result.identityFiles.length >= MAX_IDENTITY_FILES) return note(run, `more than ${MAX_IDENTITY_FILES} IdentityFile lines: the rest are ignored`)
      result.identityFiles.push(path)
      return
    }
    case 'identityagent': {
      if (!first(run, keyword)) return
      if (value === 'none') result.identityAgent = { kind: 'none' }
      else if (value === 'SSH_AUTH_SOCK') result.identityAgent = { kind: 'env', name: 'SSH_AUTH_SOCK' }
      else if (value.startsWith('$')) {
        if (isEnvName(value.slice(1))) result.identityAgent = { kind: 'env', name: value.slice(1) }
        else note(run, `IdentityAgent ${value} is not an environment variable name: ignored`)
      } else if (value.includes('%')) note(run, `IdentityAgent ${value} uses a % token: ignored`)
      else {
        const path = expandTilde(value, opts.home)
        if (path === null) note(run, `IdentityAgent ${value} is not an absolute or ~/ path: ignored`)
        else result.identityAgent = { kind: 'path', path }
      }
      return
    }
    case 'proxyjump':
    case 'proxycommand':
      // One slot for both, as in ssh: whichever comes first decides, and `none` means a direct dial.
      if (!first(run, 'proxy')) return
      result.jump = value !== 'none'
      return
    default:
      // Every other keyword is ssh's business, not the built-in client's.
      return
  }
}

async function readConfigFile(run: Run, path: string, depth: number, chain: readonly string[]): Promise<void> {
  if (chain.includes(path)) return note(run, `Include loop at ${path}: not read again`)
  if (depth > SSH_CONFIG_MAX_INCLUDE_DEPTH) return note(run, `Include deeper than ${SSH_CONFIG_MAX_INCLUDE_DEPTH} levels at ${path}: not read`)
  if (run.filesRead >= MAX_FILES) return note(run, `more than ${MAX_FILES} config files: ${path} not read`)
  run.filesRead++
  const text = await run.opts.read(path)
  // A missing file (no ~/.ssh/config at all, an Include of a file not made yet) is normal, as in ssh.
  if (text === null) return
  // Measured in bytes, as the cap is; `read` hands at most the cap plus one byte of a real file.
  if (Buffer.byteLength(text, 'utf8') > SSH_CONFIG_MAX_BYTES) {
    return note(run, `${path} is over ${SSH_CONFIG_MAX_BYTES / 1024} KiB: not read`)
  }
  const nextChain = [...chain, path]
  // Lines before the first Host or Match apply to every host; an included file starts in the state of
  // the line that included it (always active here: an inactive Include is never read), and its own
  // Host lines do not change the including file's state once it returns, as in ssh.
  let active = true
  for (const rawLine of text.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    const kw = splitKeyword(line)
    if (kw === null || kw.keyword.startsWith('#')) continue
    const args = splitConfigArgs(kw.rest)
    if (args === null) {
      note(run, `${path}: a line with an unterminated quote is ignored`)
      continue
    }
    if (kw.keyword === 'host') {
      active = hostPatternsMatch(args, run.host)
      continue
    }
    if (kw.keyword === 'match') {
      // Its conditions are not evaluated: the block counts as not matching until the next Host or
      // Match, and the caller gets the hint that it might have applied.
      active = false
      run.result.matchSkipped = true
      continue
    }
    if (!active) continue
    if (kw.keyword === 'include') {
      for (const arg of args) {
        if (arg.includes('%')) {
          note(run, `Include ${arg} uses a % token: not read`)
          continue
        }
        // ssh: a relative user-config Include is relative to ~/.ssh, not to the including file.
        const target = arg.startsWith('~') ? expandTilde(arg, run.opts.home) : isAbsolute(arg) ? arg : join(run.sshDir, arg)
        if (target === null) {
          note(run, `Include ${arg} is not a path this reader resolves: not read`)
          continue
        }
        for (const file of await expandGlob(target, run)) await readConfigFile(run, file, depth + 1, nextChain)
      }
      continue
    }
    applyKeyword(run, kw.keyword, args)
  }
}

/**
 * What `~/.ssh/config` says for `host` (the alias the record holds). A missing config is an empty
 * result; nothing here throws for a config's content, which is untrusted text like any input.
 */
export async function resolveSshConfig(host: string, opts: SshConfigOptions): Promise<SshConfigResult> {
  const sshDir = join(opts.home, '.ssh')
  const run: Run = {
    host: host.toLowerCase(),
    opts,
    sshDir,
    result: { identityFiles: [], jump: false, matchSkipped: false, notes: [] },
    seen: new Set(),
    filesRead: 0
  }
  await readConfigFile(run, opts.path ?? join(sshDir, 'config'), 0, [])
  return run.result
}
