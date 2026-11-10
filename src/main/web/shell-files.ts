// The web shell's files as the gateway serves them (design-web.md §2, plan Task 8). The renderer
// build writes them under out/renderer (electron.vite.config.ts): `web/index.html` (the shell's
// page, which also signs the browser in) and `assets/` (chunks shared with the desktop shell:
// scripts, styles, fonts). Exactly two things are served from there:
//  - `/` is web/index.html. Its `../assets/x.js` references resolve to `/assets/x.js` (a URL
//    cannot go above the root), so the built page works unchanged at `/`.
//  - `/assets/<name>`: one file name, directly in assets/. No subfolders, no dot files, only the
//    types the build writes, and the real path must still be inside assets/ (a symlink planted
//    there leads nowhere). Nothing else under out/ (the desktop page, main's and the preload's
//    code, source maps) is reachable, whatever the URL says.
// Both are open without sign-in: the shell is the sign-in page, and the files are the app's own
// public code, with no secret and nothing about this machine in them.
import { realpath } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'

/** Content types of what the renderer build writes to assets/ (and the page). Anything else is 404. */
const TYPES: Readonly<Record<string, string>> = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.svg': 'image/svg+xml',
  '.png': 'image/png'
})

export const ASSETS_PREFIX = '/assets/'

export interface ShellFile {
  /** Absolute path of the file to send (resolved, inside the shell's folders). */
  path: string
  type: string
  /** Content-hashed asset: the name changes with the content, so a browser may keep it. */
  immutable: boolean
}

/**
 * The file a request path names, or undefined (not one of ours: 404). `path` is the URL path
 * without the query. Checks the name only; `realShellFile` checks where it really is on disk.
 */
export function shellFileOf(root: string, path: string): ShellFile | undefined {
  if (path === '/') return { path: join(root, 'web', 'index.html'), type: TYPES['.html'] as string, immutable: false }
  if (!path.startsWith(ASSETS_PREFIX)) return undefined
  let name: string
  try {
    name = decodeURIComponent(path.slice(ASSETS_PREFIX.length))
  } catch {
    return undefined
  }
  // One plain file name: no separator of either kind (a `%2F` decodes to one), no `..` or dot
  // file, no NUL, and nothing a `basename` would cut down to something else.
  if (name === '' || name.startsWith('.') || name.includes('/') || name.includes('\\') || name.includes('\0')) return undefined
  if (basename(name) !== name) return undefined
  const type = TYPES[extname(name).toLowerCase()]
  // The page itself is only ever `/`; an `.html` under assets/ is not served.
  if (type === undefined || extname(name).toLowerCase() === '.html') return undefined
  return { path: join(root, 'assets', name), type, immutable: true }
}

/**
 * The file's real path when it exists and still lies in the folder it was named in (assets/ or
 * web/), after symlinks; undefined otherwise. The build writes plain files, so a link is either a
 * mistake or a plant, and a link out is refused.
 */
export async function realShellFile(file: ShellFile): Promise<string | undefined> {
  try {
    const [real, dir] = await Promise.all([realpath(file.path), realpath(dirname(file.path))])
    return dirname(real) === dir ? real : undefined
  } catch {
    return undefined
  }
}
