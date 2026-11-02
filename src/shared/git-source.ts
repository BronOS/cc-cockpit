// Git source validation and the locked-down clone, shared by the installer (main), the marketplace
// index validator and the index repo's CI tools (marketplace/tools).
// Pure: no Electron, no Node imports.

// Well past any real clone URL; bounds what untrusted text can put in plugins.json, an argv and an error.
const MAX_URL_LENGTH = 2000
// Well past any real release tag; the same bound, and git keeps a tag as a path, limited by the filesystem.
const MAX_TAG_LENGTH = 200
const GIT_TAG_PATTERN = /^[A-Za-z0-9._/-]+$/
// scp-like ssh: `git@host:path`. The host may not start with `-` (an ssh option smuggled in as a
// host name, CVE-2017-1000117) and neither may the path.
const SCP_URL = /^git@[A-Za-z0-9][A-Za-z0-9.-]*:(?!-)\S+$/

/**
 * Why `url` is not an acceptable plugin source, or null. Only three forms: `https://…`,
 * `git@host:path` (ssh) and `file:///abs/path`. Everything else is refused before git sees it,
 * notably `ext::` (runs an arbitrary command), other `<transport>::` remote helpers, `-…` (an
 * option, even though the argv puts the URL after `--`), plain http and git:// (no transport
 * security), and credentials in the URL (they would be stored in plugins.json in plain text).
 */
export function gitUrlProblem(url: unknown): string | null {
  if (typeof url !== 'string' || url === '') return 'the URL is empty'
  if (url.length > MAX_URL_LENGTH) return `the URL is longer than ${MAX_URL_LENGTH} characters`
  if (url.startsWith('-')) return 'the URL must not start with "-"'
  if (url.toLowerCase().startsWith('ext::')) return 'ext:: URLs are not allowed'
  // eslint-disable-next-line no-control-regex
  if (/[\s\x00-\x1f\x7f]/.test(url)) return 'the URL must not contain whitespace or control characters'
  // WHATWG URL parsing reads `\` as `/`, git and curl do not: `https://github.com\@evil.com/x`
  // parses as host github.com but git connects to evil.com. Refuse it rather than disagree.
  if (url.includes('\\')) return 'the URL must not contain a backslash'
  if (url.startsWith('https://')) {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return 'the URL is not a valid https URL'
    }
    if (parsed.hostname === '') return 'the URL has no host'
    if (parsed.username !== '' || parsed.password !== '') return 'the URL must not contain credentials'
    return null
  }
  if (url.startsWith('git@')) {
    return SCP_URL.test(url) ? null : 'an ssh URL must look like git@host:owner/repo'
  }
  if (url.startsWith('file://')) {
    // Only the empty-host form: `file://host/…` means something different to every parser.
    if (!url.startsWith('file:///')) return 'a file URL must be file:///absolute/path'
    return null
  }
  return 'the URL must be https://…, git@host:path or file:///path'
}

/** Why `tag` is not acceptable, or null. Travels as the value of `--branch`, after validation. */
export function gitTagProblem(tag: unknown): string | null {
  if (typeof tag !== 'string' || tag === '') return 'the tag is empty'
  if (tag.length > MAX_TAG_LENGTH) return `the tag is longer than ${MAX_TAG_LENGTH} characters`
  if (!GIT_TAG_PATTERN.test(tag)) return 'the tag may only contain letters, digits, ".", "_", "/" and "-"'
  // The pattern admits both; neither is a valid ref name and a leading `-` reads as an option.
  if (tag.startsWith('-')) return 'the tag must not start with "-"'
  if (tag.includes('..')) return 'the tag must not contain ".."'
  return null
}

/**
 * The full git argv (without `git`) for a shallow clone of `url` at `tag` into `dest`.
 * `-c` settings for this one command, overriding the user's config:
 * - `protocol.allow=never` plus `protocol.<the URL's transport>.allow=always`: the clone may use
 *   exactly the transport that was validated, so a redirect to plain http or a URL rewritten by
 *   the user's `url.<base>.insteadOf` onto something else fails instead of quietly downgrading.
 *   `protocol.ext.allow=never` is explicit because a user's config could set it to always, and
 *   `protocol.file.allow` is only opened for a `file://` URL.
 * - `core.hooksPath=/dev/null`: no hook (not even one from the user's init template) runs while
 *   the untrusted checkout is written.
 * Submodules are not cloned (clone never recurses unless asked; `submodule.recurse` does not apply
 * to clone).
 */
export function cloneArgs(url: string, tag: string, dest: string): string[] {
  const transport = url.startsWith('https://') ? 'https' : url.startsWith('file://') ? 'file' : 'ssh'
  return [
    '-c', 'protocol.allow=never',
    '-c', 'protocol.ext.allow=never',
    '-c', `protocol.file.allow=${transport === 'file' ? 'always' : 'never'}`,
    '-c', `protocol.${transport}.allow=always`,
    '-c', 'core.hooksPath=/dev/null',
    'clone', '--depth', '1', '--branch', tag, '--', url, dest
  ]
}

// Variables that point git at some other repository or object store; a login shell that exports
// one (a dotfiles setup) would make the clone read or write the wrong place.
const GIT_LOCATION_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_COMMON_DIR'
]

/**
 * The env git runs with: the login env (PATH, ssh agent socket) minus the repository-location
 * variables, plus `GIT_TERMINAL_PROMPT=0` so a private repo fails at once instead of waiting for a
 * username nobody can type. ssh prompts (passphrase, unknown host) cannot hang either: the default
 * runner starts git in its own session with no controlling terminal, so ssh fails fast.
 */
export function gitEnv(base: Record<string, string | undefined>): Record<string, string | undefined> {
  const env = { ...base }
  for (const name of GIT_LOCATION_VARS) delete env[name]
  // GIT_ALLOW_PROTOCOL is consulted before any protocol.*.allow config, so an exported one would
  // silently void the `-c` transport lock in cloneArgs.
  delete env.GIT_ALLOW_PROTOCOL
  // The checkout writes untrusted content: no git-lfs smudge filter (from the user's global config),
  // which would fetch from an lfs.url the repo's .lfsconfig picks, outside the protocol allow-list.
  env.GIT_LFS_SKIP_SMUDGE = '1'
  env.GIT_TERMINAL_PROMPT = '0'
  return env
}
