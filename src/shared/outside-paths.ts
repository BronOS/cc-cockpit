// The outside-the-project rule: which absolute paths outside a project are never handed out, whoever
// names them. One rule for two users (design-download.md §1.2 "One rule, not two lists"):
//   - main (`ccc download` of an outside path, the folder walk of an outside root) imports this file;
//   - the editor host (a read-only tab for a definition a language server returned) is plain JS with no
//     build that ships its own files, so `scripts/build-editor.mjs` emits this source as
//     `plugins/editor/dist/lib/outside-paths.js` (cjs, unminified, committed, byte-compared by
//     `test/unit/reviewer-plugin.test.ts`) and `dist/lib/files.js` requires it.
// Core to plugin, never the other way: a plugin edit must not widen what main hands out.
//
// Pure: the home and the platform are passed in (tests run the darwin cases on Linux) and nothing here
// touches the disk. The caller checks both the named path and its realpath (a `/tmp` link to
// `~/.ssh/id_ed25519` is refused by its target, as the editor's `readOutside` does).
//
// No imports but node:path, and that only for `isAbsolute` / `resolve` / `sep`: the emitted copy runs in
// the plugin host, and a second import would be one more thing the byte-compare has to carry.

import path from 'node:path'

/** Where the rule needs to know whose home it is and how the disk compares names. */
export interface OutsideEnv {
  /** The person's home folder (absolute); an empty or relative one turns the home rules off. */
  home: string
  /** `process.platform`: on darwin the default APFS volume compares names case-insensitively. */
  platform: string
}

/** System trees no definition lives in and nothing should download from (process memory and environment, devices, sockets). */
export const REFUSED_OUTSIDE_ROOTS = ['/proc', '/sys', '/dev', '/run']
/** Folders of the home with no dot in their name that hold credentials or app data (macOS). */
export const REFUSED_OUTSIDE_HOME = ['Library/Keychains', 'Library/Application Support', 'Library/Cookies']
/**
 * The hidden folders of the home that hold toolchains and libraries the supported language servers
 * (TS/JS, Go, PHP, Python; Rust for a `servers` setting) return definitions in: Node version
 * managers and global installs (the server's own TypeScript, pyright's typeshed stubs, intelephense's
 * stubs), tsserver's type acquisition cache, Go's module cache and SDK managers, Composer's global
 * vendor, Python interpreters, virtualenvs and tool installs, Cargo's sources and rustup's toolchains.
 * Every other dot folder and dot file of the home is refused (outsideRefused). A segment ending in
 * `*` matches by its prefix (`python*`). Credential files that sit beside these are left out on
 * purpose: `.config/composer` holds auth.json, so only its `vendor` is here.
 */
export const ALLOWED_HIDDEN_HOME: readonly (readonly string[])[] = [
  // Node: version managers, global prefixes, tsserver's acquired @types.
  '.nvm/versions', '.volta/tools', '.fnm/node-versions', '.local/share/fnm/node-versions', '.bun/install', '.npm-global',
  '.local/share/pnpm', '.config/yarn/global', '.cache/typescript', '.local/share/nvim/mason/packages',
  // Version managers for every language.
  '.local/share/mise/installs', '.asdf/installs',
  // Go: GOPATH=~/.go, SDK managers.
  '.go/pkg/mod', '.goenv/versions', '.gvm/gos', '.gvm/pkgsets',
  // PHP: Composer's global packages (COMPOSER_HOME ~/.composer or ~/.config/composer).
  '.composer/vendor', '.config/composer/vendor',
  // Python: user site-packages, interpreters, virtualenvs, tool installs.
  '.local/lib/python*', '.pyenv/versions', '.local/share/uv', '.virtualenvs', '.local/share/virtualenvs', '.conda/envs',
  '.cache/pypoetry/virtualenvs', '.local/pipx/venvs', '.local/share/pipx/venvs',
  // Rust (a `servers` setting): crate sources, toolchains.
  '.cargo/registry', '.cargo/git', '.rustup/toolchains',
].map((d) => d.split('/'))

/**
 * The form two paths are compared in. On darwin the default APFS volume is case- and
 * normalization-insensitive, so `~/library/keychains` and `/users/me/.ssh` name the same folders as
 * `~/Library/Keychains` and `/Users/me/.ssh`: compared as typed they would slip past the prefix
 * checks. Folded only for the refusing comparisons (roots, home, Library, data dir); the
 * ALLOWED_HIDDEN_HOME and `node_modules` matches stay exact, so a differently cased spelling there can
 * only be refused, never allowed (fails closed).
 */
function folded(p: string, platform: string): string {
  return platform === 'darwin' ? p.normalize('NFC').toLowerCase() : p
}

/** Whether `p` is `dir` or lies below it; both absolute and resolved, compared in `folded` form. */
export function underPath(p: string, dir: string, platform: string): boolean {
  const a = folded(p, platform)
  const d = folded(dir, platform)
  return a === d || a.startsWith(d.endsWith(path.sep) ? d : d + path.sep)
}

/** Whether the home-relative `segs` start with the allowed `prefix` (a `*`-ended segment by its prefix). */
function startsWithSegments(segs: readonly string[], prefix: readonly string[]): boolean {
  if (segs.length < prefix.length) return false
  return prefix.every((p, i) => (p.endsWith('*') ? (segs[i] ?? '').startsWith(p.slice(0, -1)) : segs[i] === p))
}

/** `home` resolved, or undefined when it is missing or relative (the home rules then do not apply). */
function homeOf(env: OutsideEnv): string | undefined {
  return env.home && path.isAbsolute(env.home) ? path.resolve(env.home) : undefined
}

/**
 * Whether an outside path is one that is never shown or downloaded, whoever named it. For the editor
 * it is defense in depth for the outside allow-list (lib/lsp/manager.js allowsOutside): a server
 * returns what the document text it was told leads to, and a page decides that text, so a page could
 * make a server "return" any path (tsserver's `/// <reference path>`). For `ccc download` it is what a
 * prompt-injected Claude cannot offer by name.
 *
 * A structural rule, not a list of known secrets (a list kept missing some: `~/.claude/.credentials.json`,
 * `~/.codex/auth.json`): under the home, a path with a hidden (dot) folder or file in it is refused,
 * unless that part lies in a toolchain or library folder (ALLOWED_HIDDEN_HOME), or comes after a
 * `node_modules` folder that is itself not hidden behind another dot folder (a package's own
 * `.pnpm`, `.bin`, `.cache`). Credentials, tokens, shell histories and app data all live in dot
 * folders and files of the home (the app's own data dir under `.config` among them; one placed
 * elsewhere by CC_COCKPIT_DATA_DIR is `dataDirRefused`'s). A non-absolute path is refused.
 */
export function outsideRefused(abs: unknown, env: OutsideEnv): boolean {
  if (typeof abs !== 'string' || !path.isAbsolute(abs) || abs.includes('\0')) return true
  const p = path.resolve(abs)
  if (REFUSED_OUTSIDE_ROOTS.some((d) => underPath(p, d, env.platform))) return true
  const h = homeOf(env)
  if (!h) return false
  if (!underPath(p, h, env.platform) || folded(p, env.platform) === folded(h, env.platform)) return false
  if (REFUSED_OUTSIDE_HOME.some((d) => underPath(p, path.join(h, d), env.platform))) return true
  // By segment count, not `p.slice(h.length)`: on darwin `p` matched `h` folded, and folding can change
  // a string's length (NFC, `İ` lowercased), never its separators.
  const segs = p.split(path.sep).filter(Boolean).slice(h.split(path.sep).filter(Boolean).length)
  if (ALLOWED_HIDDEN_HOME.some((prefix) => startsWithSegments(segs, prefix))) return false
  for (const seg of segs) {
    if (seg === 'node_modules') return false
    if (seg.startsWith('.')) return true
  }
  return false
}

/**
 * Downloads only (the editor never reaches it): the app's data dir and everything in it, wherever
 * CC_COCKPIT_DATA_DIR or Electron's `userData` puts it, inside a project as much as outside one. It
 * holds `secret.key`, the device records and the plugins' secrets, so neither the Files panel nor
 * Claude may hand it to a browser; under `~/.config` the outside rule already refuses it, but a data
 * dir set to `/srv/cockpit` or `<project>/.data` is not under a dot folder of the home. Paths are compared
 * as given: the caller passes the realpath of the candidate and the realpath of the data dir (macOS `/var`
 * is `/private/var`; a linked data dir would slip past a lexical compare). A missing
 * or relative `dataDir` refuses everything (the caller always has one; this fails closed).
 */
export function dataDirRefused(abs: unknown, dataDir: string, platform: string): boolean {
  if (typeof abs !== 'string' || !path.isAbsolute(abs) || abs.includes('\0')) return true
  if (!dataDir || !path.isAbsolute(dataDir)) return true
  return underPath(path.resolve(abs), path.resolve(dataDir), platform)
}

/**
 * Downloads only: a folder that may not be the root of a zip, `/` and the home itself. Their files are
 * not all refused, but a zip of either is the whole disk or the whole home minus what the walk skips,
 * which no one means by "download this folder"; the person names a folder in it instead.
 */
export function downloadRootRefused(abs: unknown, env: OutsideEnv): boolean {
  if (typeof abs !== 'string' || !path.isAbsolute(abs) || abs.includes('\0')) return true
  const p = folded(path.resolve(abs), env.platform)
  if (p === path.parse(p).root) return true
  const h = homeOf(env)
  return h !== undefined && p === folded(h, env.platform)
}
