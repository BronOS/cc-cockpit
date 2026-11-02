// `cc-plugin://<pluginId>/<path>`: the files of a plugin's panels and html overlays (plan:
// Technical Details › Panel files; design §5). The scheme is registered with the overlay scheme in
// ONE registerSchemesAsPrivileged call (overlay-protocol.ts: Electron keeps only the last list);
// this file decides what a URL serves, with no Electron import, so unit tests call it directly.
//
// What a request gets:
//   /__sdk/panel.js   the panel SDK (src/sdk/panel.ts, built to out/sdk/panel.js), for every plugin
//   /<path>           a regular file inside the plugin's folder, nothing else
//   anything else     404 (an unknown plugin, a path that leaves the folder, a directory)
// Every response, 404s included, carries the plugin's CSP: its own files only, no network, no
// inline script, no frames, no form posts, and `sandbox allow-scripts`. The last one repeats the
// iframe's sandbox attribute in the response itself: the handler serves any frame of the default
// session, so a page loaded some other way (a future view, a navigation that slipped past a guard)
// still runs in an opaque origin, never as `cc-plugin://<id>` with that origin's storage.
//
// Containment: the URL parser (a `standard` scheme) folds literal `.`/`..` segments, but an
// encoded `%2e%2e` or `%2f` survives it and would turn into `..` or `/` when decoded. So the raw
// path is refused outright when it carries an encoded dot, slash, backslash or NUL; segments are
// decoded one at a time; and the result, realpath'd, must still be inside the realpath'd plugin
// folder (a symlink pointing out is refused like `..`). The file is then read through a verified
// descriptor (verified-read.ts), never by name again, so a file or folder swapped for a symlink
// after those checks does not get a file outside the folder served.
//
// Which plugins: Electron's protocol handler is not told which window (frame) asks, so it cannot
// check the asking window's project. The caller's lookup serves only plugins that are installed,
// valid and enabled in at least one open project window (index.ts); a url overlay cannot ask at
// all (its page runs in its own session partition, where this handler is not registered).
import { readFile, realpath } from 'node:fs/promises'
import { extname, join, sep } from 'node:path'
import { PLUGIN_ID_MAX_LENGTH, PLUGIN_ID_PATTERN } from '../../shared/manifest'
import { readVerified, verifiedProblemText } from '../verified-read'
import { resolveInside } from './validate'

/** Largest plugin file served (a panel bundle with inlined assets stays far below it). */
export const MAX_PLUGIN_FILE_BYTES = 50 * 1024 * 1024

export const PLUGIN_SCHEME = 'cc-plugin'

/** Where the panel SDK is served inside every plugin's origin. */
export const PANEL_SDK_PATH = '/__sdk/panel.js'

/** Longest URL path looked at; a plugin's own paths are far shorter (the manifest caps them). */
const MAX_PATH_LENGTH = 4096

/**
 * The plan's panel CSP, plus `connect-src` for the plugin's own files (default-src 'none' would
 * block the `fetch` of its own data that the scheme's fetch/CORS privileges exist for; any other
 * host stays blocked), `form-action`/`base-uri`/`frame-src` closed like OVERLAY_PAGE_CSP, and the
 * frame's own sandbox flags (see the top of the file; a header CSP's `sandbox` is honoured, a meta
 * one is not).
 */
export function pluginCsp(pluginId: string): string {
  const self = `${PLUGIN_SCHEME}://${pluginId}`
  return [
    "default-src 'none'",
    `script-src ${self}`,
    `style-src ${self} 'unsafe-inline'`,
    `img-src ${self} data:`,
    `font-src ${self}`,
    `connect-src ${self}`,
    "frame-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    'sandbox allow-scripts'
  ].join('; ')
}

/** The URL of a file inside a plugin's folder (a path relative to it, `/` or the OS separator). */
export function pluginFileUrl(pluginId: string, relativePath: string): string {
  const segments = relativePath.split(sep === '\\' ? /[\\/]/ : '/').filter((s) => s !== '' && s !== '.')
  return `${PLUGIN_SCHEME}://${pluginId}/${segments.map(encodeURIComponent).join('/')}`
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf'
}

export function contentTypeOf(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

export interface PluginProtocolDeps {
  /** The folder of a plugin that may be served now (see the top of the file), else undefined. */
  pluginDir(pluginId: string): string | undefined
  /** The built panel SDK (out/sdk/panel.js). */
  sdkFile: string
  log?: (message: string) => void
}

/**
 * What a request resolved to: a file to send, or why not (logged, never sent to the page).
 * `checked`: the dev/inode of a plugin file as the checks saw it, which the read must find again;
 * absent for the app's own SDK file.
 */
export type PluginFileResolution =
  | { ok: true; pluginId: string; file: string; checked?: { dev: number; ino: number } }
  | { ok: false; pluginId?: string; reason: string }

/**
 * The file a `cc-plugin:` URL names, after every check above. Exported for the unit tests; the
 * handler is `servePluginRequest`.
 */
export async function resolvePluginFile(url: string, deps: Pick<PluginProtocolDeps, 'pluginDir' | 'sdkFile'>): Promise<PluginFileResolution> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, reason: 'not a URL' }
  }
  if (parsed.protocol !== `${PLUGIN_SCHEME}:`) return { ok: false, reason: 'another scheme' }
  const pluginId = parsed.hostname
  // Before the id is used anywhere (a lookup, a log line): the manifest's id rule.
  if (pluginId.length > PLUGIN_ID_MAX_LENGTH || !PLUGIN_ID_PATTERN.test(pluginId)) return { ok: false, reason: 'not a plugin id' }
  const raw = parsed.pathname
  if (raw.length > MAX_PATH_LENGTH) return { ok: false, pluginId, reason: 'path too long' }
  // %2e (.), %2f (/), %5c (\) and %00 are never needed by a plugin's own file names and are the
  // ways to smuggle a segment past the URL parser's own `..` folding.
  if (/%(?:2e|2f|5c|00)/i.test(raw) || raw.includes('\\')) return { ok: false, pluginId, reason: 'encoded separator or dot' }
  const dir = deps.pluginDir(pluginId)
  if (dir === undefined) return { ok: false, pluginId, reason: 'unknown or not enabled plugin' }
  if (raw === PANEL_SDK_PATH) return { ok: true, pluginId, file: deps.sdkFile }

  const segments: string[] = []
  for (const part of raw.split('/')) {
    if (part === '') continue
    let decoded: string
    try {
      decoded = decodeURIComponent(part)
    } catch {
      return { ok: false, pluginId, reason: 'bad escape' }
    }
    if (decoded === '.' || decoded === '..' || decoded.includes('\0') || decoded.includes('/') || decoded.includes('\\')) {
      return { ok: false, pluginId, reason: 'bad segment' }
    }
    segments.push(decoded)
  }
  if (segments.length === 0) return { ok: false, pluginId, reason: 'no file named' }

  let root: string
  try {
    root = await realpath(dir)
  } catch {
    return { ok: false, pluginId, reason: 'no such file' }
  }
  const target = await resolveInside(root, join(...segments))
  if (!target.ok) {
    if (target.problem === 'missing') return { ok: false, pluginId, reason: 'no such file' }
    if (target.problem === 'not-file') return { ok: false, pluginId, reason: 'not a regular file' }
    return { ok: false, pluginId, reason: 'outside the plugin folder' }
  }
  return { ok: true, pluginId, file: target.real, checked: { dev: target.dev, ino: target.ino } }
}

function headers(pluginId: string | undefined, contentType: string): Record<string, string> {
  return {
    'content-type': contentType,
    // A 404 for a request that did not even name a valid plugin still gets the strictest policy.
    'content-security-policy': pluginId ? pluginCsp(pluginId) : "default-src 'none'; sandbox",
    'x-content-type-options': 'nosniff',
    // Panels run in a sandboxed frame without allow-same-origin, i.e. an opaque origin: to the
    // browser every fetch of their own files (and every module script) is cross-origin and needs
    // this. Who can ask is bounded: this handler lives in the default session only (url overlays
    // have their own partition), and each page's CSP lets it reach its own plugin's files only.
    'access-control-allow-origin': '*',
    'cache-control': 'no-store'
  }
}

/** Answer one `cc-plugin:` request (the body of Electron's `protocol.handle`). */
export async function servePluginRequest(url: string, method: string, deps: PluginProtocolDeps): Promise<Response> {
  const res = method === 'GET' || method === 'HEAD' ? await resolvePluginFile(url, deps) : { ok: false as const, reason: `method ${method}` }
  if (!res.ok) {
    deps.log?.(`cc-plugin: 404 for ${res.pluginId ?? '?'}: ${res.reason}`)
    return new Response('not found', { status: 404, headers: headers(res.pluginId, 'text/plain; charset=utf-8') })
  }
  const notFound = (): Response => new Response('not found', { status: 404, headers: headers(res.pluginId, 'text/plain; charset=utf-8') })
  let body: Buffer
  try {
    if (res.checked === undefined) {
      // The app's own SDK file: not in a plugin folder, nothing for a plugin to swap.
      body = await readFile(res.file)
    } else {
      const read = await readVerified(res.file, MAX_PLUGIN_FILE_BYTES, res.checked)
      if (!read.ok) {
        deps.log?.(`cc-plugin: 404 for ${res.pluginId}: the file ${verifiedProblemText(read.problem)}`)
        return notFound()
      }
      body = read.data
    }
  } catch {
    return notFound()
  }
  return new Response(method === 'HEAD' ? null : new Uint8Array(body), {
    status: 200,
    headers: headers(res.pluginId, contentTypeOf(res.file))
  })
}
