// Guests (design-guests, shared/design.md §2 and §16.1): a guest is a web device of its own sign-in kind,
// minted only by redeeming a one-use invite, bound to ONE project of the host, a role (read or write) and a
// tab scope. These are the shared shapes main's guest store (main/web/guests.ts), the router, the
// gateway and the owner's pages build against; the rules that read them live in shared/guest-filter.ts
// (what a guest receives), shared/guest-class.ts (what a guest may call) and shared/guest-access.ts
// (which plugins a guest sees).
//
// Nothing here is a secret: an invite is kept as the SHA-256 of its token, so guests survive a switch of
// the secret store (desktop keychain / server key file) and a host restart (D-12).
//
// Pure: no Node, DOM or Electron imports (main, the renderer and the web client all import it).

import type { GuestRole, ViewAccess } from './views'

export type { GuestRole } from './views'

/**
 * Which tabs of the project a guest sees: `all` (dynamic: every terminal and page tab, now and later,
 * except what hidden plugins opened; shared/guest-filter.ts `tabVisible`), or a fixed list of tab ids
 * (`TabRecord.id`, which is the live `TabInfo.id` during a run; remapped on restore through
 * `GuestService.remap`, as split-group leaves are).
 */
export type GuestScope = 'all' | readonly string[]

/** How long a redeemed guest stays (D-12): picked at invite, default one day. */
export type GuestLifetime = '1d' | '7d' | 'forever'
export const GUEST_LIFETIMES: readonly GuestLifetime[] = ['1d', '7d', 'forever']
export const DEFAULT_GUEST_LIFETIME: GuestLifetime = '1d'
/** A lifetime in ms; null: until the owner removes the guest. */
export const GUEST_LIFETIME_MS: Readonly<Record<GuestLifetime, number | null>> = Object.freeze({
  '1d': 24 * 3600_000,
  '7d': 7 * 24 * 3600_000,
  forever: null
})

/** An invite nobody redeemed expires this long after it was made, whatever the guest's lifetime. */
export const INVITE_UNUSED_MS = 24 * 3600_000
/** New tabs one write guest may open (D-21); a tab it opened and closed counts no more. */
export const MAX_GUEST_TABS = 4
/** Live guests plus pending invites, app-wide (`guests.invite` answers `cap` past it). */
export const MAX_GUESTS = 16
/** Live views one guest device may have of its project at once (spec-review 21, at `hello`). */
export const MAX_GUEST_VIEWS_PER_DEVICE = 2
/** A guest's name: typed by the owner, plain text, unique among live guests. */
export const GUEST_NAME_MAX = 60
/** The invite token: 32 random bytes, base64url without padding. */
export const INVITE_TOKEN_CHARS = 43

/**
 * D-19: invite redemption has its own failed-attempt bucket (main/web/auth.ts AttemptLimiter options),
 * so guessing invites on a public tunnel cannot slow the owner's sign-in. Same pace as the owner's
 * bucket, a shorter queue: a redeem is one request per guest, so a long wait list is only an attacker.
 */
export const INVITE_ATTEMPT_CAPACITY = 10
export const INVITE_ATTEMPT_REFILL_MS = 6000
export const INVITE_ATTEMPT_DELAY_MS = 1000
export const INVITE_ATTEMPT_MAX_WAITING = 16

/** One pending invite as main stores it (`web-access.json`, beside the devices). */
export interface InviteRecord {
  id: string
  /** Lowercase hex SHA-256 of the token; the token itself is never stored. */
  hash: string
  /** The guest the redeem creates (minted with the invite, so the owner's list names it at once). */
  guestId: string
  name: string
  role: GuestRole
  projectId: string
  scope: GuestScope
  lifetime: GuestLifetime
  createdAt: number
  /** `createdAt + INVITE_UNUSED_MS`. */
  expiresAt: number
}

/** A redeemed guest. */
export interface GuestRecord {
  id: string
  name: string
  role: GuestRole
  projectId: string
  scope: GuestScope
  createdAt: number
  /** When the guest's access ends (the lifetime counted from the redeem); null: until removed. */
  until: number | null
  /** Tabs this guest opened (D-9: it may close only these; D-21: they join its scope; cap MAX_GUEST_TABS). */
  openedTabs: string[]
}

/**
 * The one answer to "who is this caller now" (`GuestService.access`), read live on every call, event,
 * port frame and HTTP route. Tagged so a check that forgets a case fails to compile. `revoked`: a
 * guest id the store no longer has (kicked, expired): treated as nobody, never as the owner.
 */
export type GuestAccess =
  | { kind: 'owner' }
  | { kind: 'guest'; id: string; name: string; role: GuestRole; projectId: string; scope: GuestScope }
  | { kind: 'revoked' }

/** The guest variant of GuestAccess, what every guest filter takes. */
export type GuestOnlyAccess = Extract<GuestAccess, { kind: 'guest' }>

/** `access` as plugins and pages learn it; `revoked` has none (such a view is being closed). */
export function viewAccessOf(access: GuestAccess): ViewAccess | undefined {
  if (access.kind === 'owner') return 'owner'
  if (access.kind === 'guest') return access.role
  return undefined
}

/** One row of the owner's guest list (`guests.list`, `guests.changed`, `ccc web guests --json`). */
export interface GuestView {
  id: string
  name: string
  role: GuestRole
  projectId: string
  scope: GuestScope
  /** `pending`: an invite nobody redeemed yet; `away`: redeemed, no live view now; `offline`: past its grace. */
  state: 'pending' | 'live' | 'away' | 'offline'
  until: number | null
  inviteId?: string
  inviteExpiresAt?: number
  /** Titles of this guest's page tabs with unsaved changes (main's per (tab, view) dirty): a downgrade warns. */
  unsaved?: string[]
}

/** `guests.invite`: what the owner's dialog (or `ccc web invite`) asks for. The project is the caller's. */
export interface GuestInviteRequest {
  name: string
  role: GuestRole
  scope: GuestScope
  lifetime: GuestLifetime
}

/**
 * Why an invite was not made: `none-mode` (sign-in None, D-1), `name-taken` (a live guest has the
 * name), `cap` (MAX_GUESTS), `full` (the device store is full).
 */
export type GuestInviteError = 'none-mode' | 'name-taken' | 'cap' | 'full'
export const GUEST_INVITE_ERRORS: readonly GuestInviteError[] = ['none-mode', 'name-taken', 'cap', 'full']

/**
 * The answer to `guests.invite`. `link` is shown once (the token is in its fragment). `warning`:
 * web access listens on loopback only, so nobody else can reach the link yet (D-35, a warning).
 */
export type GuestInviteAnswer =
  | { ok: true; link: string; inviteId: string; guestId: string; expiresAt: number; warning?: 'loopback-only' }
  | { ok: false; error: GuestInviteError }

/** One person in the presence snapshot (design §10, §16.7). */
export interface PresencePerson {
  /** `owner` or the guest id. */
  id: string
  /** The owner: the Web access setting (D-24, default "Host"); a guest: its invite name. */
  name: string
  role: ViewAccess
  /** Palette index 0..7, stable per id. */
  color: number
  state: 'live' | 'away' | 'reconnecting'
  /** The tab the person's most recently active view shows; null when none (or not visible to the receiver). */
  tabId: string | null
  /** Guest filter: the person looks at a tab the receiving guest cannot see. */
  elsewhere?: true
  /** Keys in the last 2 s. */
  typing: boolean
}

/** `presence.changed` and `presence.get`: the whole picture, at most 4 a second. */
export interface PresenceSnapshot {
  seq: number
  people: PresencePerson[]
  /** tabId -> the id of the person who typed there last. */
  lastTyped: Record<string, string>
}

/**
 * Whether a tab id is in a scope. The scope part of the rule only: shared/guest-filter.ts
 * `tabVisible` adds the tabs the guest opened and the plugin rule (tabs a hidden plugin opened).
 */
export function inScope(scope: GuestScope, tabRecordId: string): boolean {
  if (scope === 'all') return true
  return Array.isArray(scope) && scope.includes(tabRecordId)
}

/** A tab id as scopes and lists carry it: main mints UUIDs; bounded so a hostile file or payload stays small. */
const MAX_TAB_ID_CHARS = 128
/** Selected tabs one scope may list: far more than a project's tabs. */
export const MAX_SCOPE_TABS = 256

/**
 * A scope from untrusted input (a page's `guests.invite` / `setScope`, `web-access.json`): `all`, or an
 * array of distinct non-empty strings, capped. Undefined for anything else (the caller refuses).
 */
export function guestScopeOf(raw: unknown): GuestScope | undefined {
  if (raw === 'all') return 'all'
  if (!Array.isArray(raw) || raw.length > MAX_SCOPE_TABS) return undefined
  const out: string[] = []
  for (const id of raw) {
    if (typeof id !== 'string' || id.length === 0 || id.length > MAX_TAB_ID_CHARS) return undefined
    if (!out.includes(id)) out.push(id)
  }
  return out
}

/** A role from untrusted input, else undefined. */
export function guestRoleOf(raw: unknown): GuestRole | undefined {
  return raw === 'read' || raw === 'write' ? raw : undefined
}

/** A lifetime from untrusted input, else undefined. */
export function guestLifetimeOf(raw: unknown): GuestLifetime | undefined {
  return typeof raw === 'string' && (GUEST_LIFETIMES as readonly string[]).includes(raw) ? (raw as GuestLifetime) : undefined
}

/** When a guest redeemed at `redeemedAt` with `lifetime` ends; null: never by itself. */
export function guestUntil(lifetime: GuestLifetime, redeemedAt: number): number | null {
  const ms = GUEST_LIFETIME_MS[lifetime]
  return ms === null ? null : redeemedAt + ms
}
