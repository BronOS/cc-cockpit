// Root-absolute URLs in a plugin's page files (design-web.md §5.5, plan Task 21). A page written for
// `cc-plugin://<id>/` can say `/__sdk/panel.js`, where `/` is the plugin's own root. Over web access the
// page lives under `/p/<token>/<id>/`, so a root-absolute URL points at the gateway's root instead.
// The gateway rewrites root-absolute `src` and `href` in HTML (plugin-pages.ts); everything else
// (`srcset`, `poster`, `<form action>`, an entity-encoded slash, a URL built in script or CSS) fails
// closed there, so this check flags all of them and a page is better off with relative URLs.
// A warning, never an error: the page still works on the desktop. The scan is a heuristic over text
// (no parsing), tuned to rarely cry wolf: a script string is flagged only when it looks like an asset
// path (a known file extension) or names `/__sdk/`.
import { promises as fs } from 'node:fs'
import path from 'node:path'

/** A slash that starts a root-absolute URL, as written or entity-encoded (`&#47;`, `&#x2f;`, `&sol;`). */
const SLASH = String.raw`(?:\/|&#0*47;?|&#x0*2f;?|&sol;)`
/** What may follow that first slash for it to be root-absolute: not `//` (protocol-relative) or `/\`. */
const NOT_SECOND = String.raw`(?![\/\\]|&#0*47;?|&#x0*2f;?|&sol;|&bsol;|&#0*92;?)`
/** URL attributes. `srcset` and `imagesrcset` hold a list, handled apart. */
const ATTR_RE = new RegExp(
  String.raw`\b(src|href|poster|action|formaction|data|manifest|ping|data-src)\s*=\s*(?:"\s*|'\s*|(?=[^\s"'>]))(${SLASH})${NOT_SECOND}([^"'\s>]*)`,
  'gi'
)
const SRCSET_RE = /\b(?:srcset|imagesrcset)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi
const SRCSET_ROOT_RE = new RegExp(String.raw`(?:^|,)\s*(${SLASH})${NOT_SECOND}(\S*)`, 'gi')
/** `url(/x)`, `url("/x")` and `@import "/x"` in CSS (also inside an HTML style element or attribute). */
const CSS_URL_RE = /\burl\(\s*["']?(\/(?![/\\])[^"')\s]*)/gi
const CSS_IMPORT_RE = /@import\s+["'](\/(?![/\\])[^"']*)/gi
const ASSET_EXT = 'js|mjs|css|html?|json|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|wasm|map'
/** A string literal that starts with `/` and looks like a file of the plugin, or is the SDK. */
const JS_STRING_RE = new RegExp(
  String.raw`(["'\x60])(\/__sdk\/[\w./-]*|\/(?![\/\\*])[\w.-]+(?:\/[\w.-]+)*\.(?:${ASSET_EXT})(?:[?#][^"'\x60]*)?)\1`,
  'g'
)

const MAX_PER_FILE = 5

function first(value: string): string {
  return value.length > 60 ? `${value.slice(0, 57)}...` : value
}

/**
 * The root-absolute URLs one file uses, as text for a person (`"/dist/x.js" (src)`). `kind` picks the
 * rules: html (attributes, inline CSS and inline script), css, js. Never throws; at most
 * MAX_PER_FILE entries, the first ones.
 */
export function rootAbsoluteUrls(kind: 'html' | 'css' | 'js', text: string): string[] {
  const found: string[] = []
  const add = (url: string, where: string): void => {
    const entry = `"${first(url)}" (${where})`
    if (found.length < MAX_PER_FILE && !found.includes(entry)) found.push(entry)
  }
  if (kind === 'html') {
    for (const m of text.matchAll(ATTR_RE)) add(`${m[2] ?? ''}${m[3] ?? ''}`, (m[1] ?? '').toLowerCase())
    for (const m of text.matchAll(SRCSET_RE)) {
      const list = m[1] ?? m[2] ?? m[3] ?? ''
      for (const c of list.matchAll(SRCSET_ROOT_RE)) add(`${c[1] ?? ''}${c[2] ?? ''}`, 'srcset')
    }
  }
  if (kind === 'html' || kind === 'css') {
    for (const m of text.matchAll(CSS_URL_RE)) add(m[1] ?? '', 'css url()')
    for (const m of text.matchAll(CSS_IMPORT_RE)) add(m[1] ?? '', 'css @import')
  }
  // In HTML only the inline script elements: an attribute value in quotes would match too.
  const script = kind === 'html' ? [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script/gi)].map((m) => m[1] ?? '').join('\n') : kind === 'js' ? text : ''
  for (const m of script.matchAll(JS_STRING_RE)) add(m[2] ?? '', 'script string')
  return found
}

const MAX_FILES = 2000
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_WARNINGS = 20
const SKIP_DIRS = new Set(['node_modules', '.git'])

function kindOf(file: string): 'html' | 'css' | 'js' | undefined {
  const ext = path.extname(file).toLowerCase()
  if (ext === '.html' || ext === '.htm') return 'html'
  if (ext === '.css') return 'css'
  if (ext === '.js' || ext === '.mjs') return 'js'
  return undefined
}

/** The manifest's `main` as a plugin-relative path, as a list (empty when there is none or it is unreadable). */
async function mainOf(dir: string): Promise<string[]> {
  try {
    const file = path.join(dir, 'plugin.json')
    if (!(await fs.lstat(file)).isFile()) return []
    const main = (JSON.parse(await fs.readFile(file, 'utf8')) as { main?: unknown }).main
    return typeof main === 'string' ? [path.posix.normalize(main)] : []
  } catch {
    return []
  }
}

async function walk(root: string, dir: string, out: string[]): Promise<void> {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (out.length >= MAX_FILES) return
    // Only regular files and folders: a symlink could point out of the plugin (the scan reads, never follows).
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) await walk(root, path.join(dir, e.name), out)
    } else if (e.isFile()) out.push(path.relative(root, path.join(dir, e.name)).split(path.sep).join('/'))
  }
}

/**
 * Warnings for a plugin folder: root-absolute URLs in its page files. Pages are the `.html` files; a
 * `.js` or `.css` file counts only when it sits in (or under) a folder that holds a page, so the host
 * bundle (`main`, `lib/` of the backend) and its `/proc/x.json`-like strings are never looked at.
 * The manifest's `main` is left out as well. Never throws.
 */
export async function rootAbsoluteUrlWarnings(dir: string): Promise<string[]> {
  const skip = await mainOf(dir)
  const files: string[] = []
  await walk(dir, dir, files)
  const pageDirs = files.filter((f) => kindOf(f) === 'html').map((f) => path.posix.dirname(f))
  const warnings: string[] = []
  for (const file of files) {
    const kind = kindOf(file)
    if (kind === undefined || skip.includes(file)) continue
    const folder = path.posix.dirname(file)
    if (kind !== 'html' && !pageDirs.some((d) => d === '.' || folder === d || folder.startsWith(`${d}/`))) continue
    let text: string
    try {
      const full = path.join(dir, file)
      const st = await fs.lstat(full)
      if (!st.isFile() || st.size > MAX_FILE_BYTES) continue
      text = await fs.readFile(full, 'latin1')
    } catch {
      continue
    }
    const urls = rootAbsoluteUrls(kind, text)
    if (urls.length > 0) {
      warnings.push(`${file}: root-absolute URL ${urls.join(', ')}; use a URL relative to the page (../dist/x.js), it breaks over web access`)
    }
    if (warnings.length >= MAX_WARNINGS) break
  }
  return warnings
}
