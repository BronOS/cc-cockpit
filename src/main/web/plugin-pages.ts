// Plugin pages and inline overlays over HTTP (design-web.md §5.5; ported from the plugin-panel
// spike, src/main/web-spike/panels.ts on spike/web-plugin-panel, where a real Chromium proved the
// headers below).
//
// Paths. A remote view's browser loads a plugin's files from `/p/<token>/<pluginId>/<path>` and an
// inline overlay (`ccc overlay --html`, `cc-overlay://<id>/` on the desktop) from
// `/o/<token>/<overlayId>/`. Tokens are minted by main, ONE per (device, plugin) and one per device
// for overlays, and told only to the web shell (`ready.paths`, WebPagePaths). A page that reads its
// own URL learns only its own plugin's token: another plugin's id under it is refused like a
// made-up token. The token is the only credential: a plugin page runs sandboxed (an opaque
// origin), so its requests are cross-site and the device cookie (SameSite=Strict) does not go with
// them; the gateway serves these paths before its cookie check. Hence per plugin, and dead when
// the device is revoked or expires (the gateway's onRevoked), when None mode is left (the anonymous
// device), and when web access stops.
//
// A token is not enough on its own: a file is served only while the token's device has an open
// view bound to a project in which the plugin is enabled now (installed, valid, switched on: the
// same rule as the desktop's `cc-plugin:` handler, narrowed to the device's own projects), and an
// overlay only while it is open in a window the device has a view of. So a token copied off a
// screen is worthless once the device's views close, and a plugin turned off stops being served at
// once, reloads included.
//
// The file itself is found by the desktop's own resolver (plugin-protocol.ts: containment,
// realpath, verified read, size cap), fed `cc-plugin://<pluginId><path>`, so this file adds no
// path logic of its own. The raw request path is split before any decoding, so a `..` or an
// encoded slash cannot move the token or the plugin id; the resolver refuses both in the rest.
//
// Headers. Every answer carries the plugin CSP rewritten for the path (`webPluginCsp`: script,
// style, img, font and connect sources are `<origin>/p/<token>/<pluginId>/` and nothing else of the
// origin), `sandbox allow-scripts` as a CSP directive (an opaque origin even when the URL is opened
// outside the frame, never the shell's origin with its socket), `frame-ancestors` the shell's own
// origins, Referrer-Policy no-referrer, Cache-Control no-store, and `Access-Control-Allow-Origin:
// null` (the sandboxed page's own fetches and module scripts are CORS requests from origin
// `null`). Never a redirect: a browser matches only the origin, not the path, of a CSP source after
// a redirect, so one would open the whole origin to the page. No `allow-popups` (the desktop gives
// it to the reviewer's mail frame, whose popup becomes a checked link open on the host; a remote
// view has no such path).
//
// Root-absolute URLs. Plugin pages were written for `cc-plugin://<id>/`, where `/x` is the plugin's
// own `x`, and the guide used to tell every page to load `/__sdk/panel.js`. Under a path prefix
// `/x` is the gateway's root instead: outside the token and outside the CSP. So HTML files get their
// root-absolute `src` and `href` attributes rewritten into the prefix (a space after the quote
// included: a browser strips it). URLs built in script or CSS (`fetch('/data.json')`, `url(/x.png)`),
// and those in other attributes (`srcset`, `poster`, `<form action>`) or with an entity-encoded
// slash, are not rewritten and fail closed (CSP-blocked, never another plugin's prefix); the guide
// and the plugin check steer plugins to relative URLs (plan Task 21). The rewrite works on the
// bytes as latin1, so a page in any ASCII-compatible charset comes out byte for byte as the desktop
// serves it, plus the ASCII prefix. The SDK is served at `<prefix>__sdk/panel.js`, so both the
// rewritten `/__sdk/panel.js` and a relative `./__sdk/panel.js` reach it.
import { randomBytes } from 'node:crypto'
import { overlayPageHeaders } from '../overlays/overlay-manager'
import { pluginCsp, servePluginRequest } from '../plugins/plugin-protocol'
import { isOverlayId, OVERLAY_PAGES_PATH, PLUGIN_PAGES_PATH, type WebPagePaths } from '../../shared/web-protocol'

/** The token key of a device's inline overlays; never a plugin id (the manifest's id rule has no `@`). */
const OVERLAY_KEY = '@overlays'

/** A token's length: 24 random bytes, base64url. */
const TOKEN_LENGTH = 32

/**
 * Whether a path segment is a token's shape (32 base64url characters); anything else is not looked
 * up. A length and charset loop, as checks.ts: the gateway's path parsing uses no regex.
 */
function isTokenShape(token: string): boolean {
  if (token.length !== TOKEN_LENGTH) return false
  for (let i = 0; i < token.length; i++) {
    const c = token.charCodeAt(i)
    const ok =
      (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) || c === 0x2d || c === 0x5f
    if (!ok) return false
  }
  return true
}

/** The prefix a plugin token serves: `/p/<token>/<pluginId>/`. */
function pluginPrefix(token: string, pluginId: string): string {
  return `${PLUGIN_PAGES_PATH}${token}/${pluginId}/`
}

/** The prefix a device's overlay token serves: `/o/<token>/`. */
function overlayPrefix(token: string): string {
  return `${OVERLAY_PAGES_PATH}${token}/`
}

/**
 * The desktop's plugin CSP (plugin-protocol.ts pluginCsp) with every `cc-plugin://<id>` source
 * replaced by `<origin><prefix>` for each origin the shell may be loaded under (a host-source with a
 * path ending in `/` matches that folder and below), its `sandbox` replaced by `sandbox
 * allow-scripts` (no popups), and `frame-ancestors` the shell's origins.
 */
export function webPluginCsp(pluginId: string, origins: readonly string[], prefix: string): string {
  const own = [...new Set(origins)]
  const selves = own.map((o) => `${o}${prefix}`).join(' ')
  return [
    ...pluginCsp(pluginId)
      .split('; ')
      .filter((d) => !d.startsWith('sandbox'))
      .map((d) => d.replaceAll(`cc-plugin://${pluginId}`, selves)),
    `frame-ancestors ${own.join(' ') || "'none'"}`,
    'sandbox allow-scripts'
  ].join('; ')
}

/** An inline overlay's CSP over HTTP: the desktop's page CSP plus the sandbox and framing rules. */
export function webOverlayCsp(origins: readonly string[]): string {
  const own = [...new Set(origins)]
  return [overlayPageHeaders()['content-security-policy'], `frame-ancestors ${own.join(' ') || "'none'"}`, 'sandbox allow-scripts'].join('; ')
}

/** Tokens of plugin and overlay paths: one per (device, key), where the key is a plugin id or OVERLAY_KEY. */
export class PageTokens {
  private readonly byToken = new Map<string, { deviceId: string; key: string }>()
  private readonly byDevice = new Map<string, Map<string, string>>()

  /** The device's token for `key` (minted on first use, then the same until dropped). */
  tokenFor(deviceId: string, key: string): string {
    let mine = this.byDevice.get(deviceId)
    if (!mine) this.byDevice.set(deviceId, (mine = new Map<string, string>()))
    let token = mine.get(key)
    if (token === undefined) {
      token = randomBytes(24).toString('base64url')
      mine.set(key, token)
      this.byToken.set(token, { deviceId, key })
    }
    return token
  }

  /**
   * A plain Map lookup, not a constant-time compare: the key is hashed, and a string compare runs
   * only against a stored token in the same bucket, so the time taken says nothing about how much
   * of a guess matches a live token; with 192 random bits there is nothing to guess byte by byte.
   * devices.ts compares in constant time because there the id is public and only the secret is checked.
   */
  lookup(token: string): { deviceId: string; key: string } | undefined {
    return this.byToken.get(token)
  }

  /** The device is revoked, expired or (None) gone: its tokens stop serving, a new view gets new ones. */
  dropDevice(deviceId: string): void {
    for (const token of this.byDevice.get(deviceId)?.values() ?? []) this.byToken.delete(token)
    this.byDevice.delete(deviceId)
  }

  /** Web access stopped: every token dies. */
  clear(): void {
    this.byToken.clear()
    this.byDevice.clear()
  }

  /** How many tokens are live (tests). */
  size(): number {
    return this.byToken.size
  }
}

export interface PluginPagesDeps {
  /** Every installed plugin's id: the web shell gets a prefix for each (what is served is decided per request). */
  pluginIds(): string[]
  /** The windows and projects the device's open views are bound to now (WebConnections). */
  deviceViews(deviceId: string): Array<{ windowId: number; projectId: string }>
  /** The folder of a plugin installed, valid and enabled in the project, else undefined. */
  pluginDir(projectId: string, pluginId: string): string | undefined
  /** An open inline overlay's page and its window (OverlayManager.inlinePage). */
  overlayPage(overlayId: string): { windowId: number; html: string } | undefined
  /** The built panel SDK (out/sdk/panel.js). */
  sdkFile: string
  log?: (message: string) => void
}

/** An answer for the gateway to write as is (status, headers, body). */
export interface PageAnswer {
  status: number
  headers: Record<string, string>
  body: Buffer
}

/** The one refusal: 404 with the strictest policy (no CORS), whatever the reason (logged, never told). */
export function pageNotFound(): PageAnswer {
  return {
    status: 404,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      // The strictest policy, and no CORS: a refusal tells a page nothing it could read.
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer'
    },
    body: Buffer.from('not found')
  }
}

/**
 * Root-absolute `src` / `href` attributes (`/x`, not `//host`), quoted or not, with or without
 * spaces after the quote: the only URLs rewritten into the prefix. Linear: no nested quantifiers,
 * and the two space runs around the quote cannot split one run between them (the quote is required
 * before the second), which would make a long run of spaces quadratic.
 */
const ROOT_ATTR = /(\s(?:src|href)\s*=\s*(?:["']\s*)?)\/(?![/\\])/gi

/** An HTML page's root-absolute `src`/`href` attributes pointed into the plugin's prefix. */
export function rewriteRootUrls(html: string, prefix: string): string {
  return html.replace(ROOT_ATTR, (_m, head: string) => `${head}${prefix}`)
}

/** Plugin files and inline overlays for remote views (see the top of the file). */
export class PluginPages {
  readonly tokens = new PageTokens()

  constructor(private readonly deps: PluginPagesDeps) {}

  /** The web shell's paths for this device: a prefix per installed plugin, and the overlay prefix. */
  paths(deviceId: string): WebPagePaths {
    const plugins: Record<string, string> = {}
    // Sorted: the same set gives the same JSON, so WebConnection.refreshPaths sends only a change.
    for (const id of [...new Set(this.deps.pluginIds())].sort()) plugins[id] = pluginPrefix(this.tokens.tokenFor(deviceId, id), id)
    return { plugins, overlays: overlayPrefix(this.tokens.tokenFor(deviceId, OVERLAY_KEY)) }
  }

  /** Whether the gateway should hand this request path here (before its cookie check). */
  static handles(path: string): boolean {
    return path.startsWith(PLUGIN_PAGES_PATH) || path.startsWith(OVERLAY_PAGES_PATH)
  }

  /**
   * Answer a GET or HEAD for `path` (the raw request path, no query). `origins`: every origin the
   * shell may be loaded under (the request's own, the external one), for the CSP. Never throws:
   * anything unexpected is a 404.
   */
  async serve(path: string, method: string, origins: readonly string[]): Promise<PageAnswer> {
    try {
      if (method !== 'GET' && method !== 'HEAD') return pageNotFound()
      if (path.startsWith(PLUGIN_PAGES_PATH)) return await this.servePlugin(path, method, origins)
      if (path.startsWith(OVERLAY_PAGES_PATH)) return this.serveOverlay(path, origins)
    } catch (err) {
      this.deps.log?.(`web access: plugin page failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    return pageNotFound()
  }

  private owner(token: string | undefined): { deviceId: string; key: string } | undefined {
    return token !== undefined && isTokenShape(token) ? this.tokens.lookup(token) : undefined
  }

  private async servePlugin(path: string, method: string, origins: readonly string[]): Promise<PageAnswer> {
    // ['', 'p', token, pluginId, ...rest]
    const parts = path.split('/')
    if (parts.length < 5) return pageNotFound()
    const token = parts[2]
    const pluginId = parts[3] ?? ''
    const owner = this.owner(token)
    // The token names one plugin: another plugin's id under it is refused like an unknown token.
    // Only the second is logged: a page trying another plugin's files is worth a line, while
    // made-up tokens are anyone past the Host check and would only flood the log.
    // The overlay key is not a plugin id: never a plugin folder lookup, whatever the projects hold.
    if (!owner || owner.key !== pluginId || owner.key === OVERLAY_KEY) {
      if (owner) this.deps.log?.(`web access: plugin path refused (token of another plugin)`)
      return pageNotFound()
    }
    // Enabled in a project one of the device's open views shows: the first such project's folder.
    const views = this.deps.deviceViews(owner.deviceId)
    let dir: string | undefined
    for (const { projectId } of views) {
      dir = this.deps.pluginDir(projectId, pluginId)
      if (dir !== undefined) break
    }
    if (dir === undefined) return pageNotFound()
    const served = dir
    const rest = `/${parts.slice(4).join('/')}`
    const res = await servePluginRequest(`cc-plugin://${pluginId}${rest}`, method === 'HEAD' ? 'GET' : method, {
      pluginDir: (id) => (id === pluginId ? served : undefined),
      sdkFile: this.deps.sdkFile,
      ...(this.deps.log ? { log: this.deps.log } : {})
    })
    if (res.status !== 200) return pageNotFound()
    const contentType = res.headers.get('content-type') ?? 'application/octet-stream'
    const prefix = pluginPrefix(token as string, pluginId)
    let body = Buffer.from(await res.arrayBuffer())
    // latin1 both ways is byte for byte: a page in another charset, or with invalid UTF-8, keeps
    // its bytes (a UTF-8 round trip would turn them into U+FFFD); the prefix is ASCII.
    if (contentType.startsWith('text/html')) body = Buffer.from(rewriteRootUrls(body.toString('latin1'), prefix), 'latin1')
    return {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Security-Policy': webPluginCsp(pluginId, origins, prefix),
        'X-Content-Type-Options': 'nosniff',
        'Access-Control-Allow-Origin': 'null',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer'
      },
      body
    }
  }

  private serveOverlay(path: string, origins: readonly string[]): PageAnswer {
    // ['', 'o', token, overlayId, ''] exactly: an overlay page is one document, no other path.
    const parts = path.split('/')
    if (parts.length !== 5 || parts[4] !== '') return pageNotFound()
    const owner = this.owner(parts[2])
    const overlayId = parts[3] ?? ''
    if (!owner || owner.key !== OVERLAY_KEY || !isOverlayId(overlayId)) return pageNotFound()
    const page = this.deps.overlayPage(overlayId)
    // Open, and in a window the device has a view of: another window's overlay id is not enough.
    if (!page || !this.deps.deviceViews(owner.deviceId).some((v) => v.windowId === page.windowId)) return pageNotFound()
    const base = overlayPageHeaders()
    return {
      status: 200,
      headers: {
        'Content-Type': base['content-type'] as string,
        'Content-Security-Policy': webOverlayCsp(origins),
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer'
      },
      body: Buffer.from(page.html, 'utf8')
    }
  }
}
