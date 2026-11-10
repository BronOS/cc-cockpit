// The views of a project window (design-web.md §2.1, §5.1). A project window can have several
// live views at once: the desktop window's own page and remote browser views, one per gateway
// connection. Every IPC caller resolves to the window's SenderContext plus the id of the view it
// came from; handlers that keep per-view state (selection, overlay answers, terminal size) key it
// by that id, the rest ignore it.
//
// Ids are minted by main only, never taken from a renderer, a frame or a plugin:
// - `desktop:<windowId>`: the desktop window's own view (one per window, so the window id is enough);
// - `web:<n>`: a remote view, one per gateway connection, `n` counting up for the app's life.
//
// Where a view id travels through a plugin host (a panel port's tag, an RPC envelope; ported from
// spike 2, branch `spike/web-plugin-panel`), only a remote id is carried and an absent one means
// the desktop view, so nothing that exists today changes shape: `viewIdOf` parses that hint.

/** A view id main minted: `desktop:<windowId>` or `web:<n>`. */
export type ViewId = string

/**
 * Who is behind a call. v1 has one person (the owner of the machine); multi-user (design §10) adds
 * people. Kept on every caller now so a later per-person check has a field to read, not a refactor.
 */
export type Who = 'owner'

/**
 * A remote view id main mints. Anchored, one literal prefix and a bounded digit run: linear, so a
 * hostile string from a host message cannot make it slow.
 */
export const VIEW_ID_PATTERN = /^web:[1-9][0-9]{0,11}$/

/**
 * `raw` when it is a remote view id main could have minted, else undefined. Used on hints that come
 * back from a plugin host (a port tag, an RPC envelope): anything else is dropped and read as the
 * desktop view, so a host cannot invent a view, only echo one main gave it.
 */
export function viewIdOf(raw: unknown): ViewId | undefined {
  return typeof raw === 'string' && VIEW_ID_PATTERN.test(raw) ? raw : undefined
}

/** Whether `id` is a remote (browser) view's id rather than a desktop window's. */
export function isRemoteViewId(id: ViewId): boolean {
  return viewIdOf(id) !== undefined
}

/** The desktop window's own view id. */
export function desktopViewId(windowId: number): ViewId {
  return `desktop:${windowId}`
}

/** The id of the `n`th remote view (n counts from 1). Main's gateway is the only caller. */
export function remoteViewId(n: number): ViewId {
  if (!Number.isSafeInteger(n) || n < 1 || n > 999_999_999_999) {
    throw new Error(`remoteViewId: bad view number ${n}`)
  }
  return `web:${n}`
}
