// The guest store (design-guests §2, §3, §14; shared/design.md §16.1, §16.8): invites, redeemed guests and
// ended-guest tombstones, kept in the guest section of `<data>/web-access.json` (devices.ts), and the live
// answers every guest check reads (`GuestService`, main/ipc/guest-deps.ts).
//
// Identity vs rights. A guest's device carries only its guest id (devices.ts `mode: 'guest'`). The view
// freezes `{ guest: id }` at `hello`; everything that id may do is read here, live, on every call, event,
// port frame and HTTP route (`access`), so a kick, a role switch or a lifetime's end holds at once.
//
// Invites. 256 random bits in the link's fragment (`#i=`, web-protocol.ts `inviteLink`), stored only as
// their SHA-256: nothing in this file is a secret, so guests survive a host restart (D-12) and a switch of
// the secret store. One use (the redeem checks and spends it in one synchronous step: two parallel redeems
// make one device, the second is told `used`), 24 h unused (INVITE_UNUSED_MS), bound to a name, a role, a
// project, a scope and a lifetime the owner chose. Never under sign-in None (D-1: `authorize` falls back
// to the anonymous owner when no cookie matches, so a guest who drops its cookie would become the owner).
//
// Ends. A kick, a lifetime's end, a forgotten project, a revoke of the guest's device in the device list,
// Revoke all and an idle device's expiry all end the guest the same way (`end`): its views are closed
// with the code its page shows (kicked / access ended) BEFORE its devices are revoked (a revoke alone reads
// as "signed out"), its device's cookie hash is kept as a tombstone for 7 days (D-32: the page says "your
// access ended", not the owner's sign-in form), its record and invites go. A role switch (4461) and a
// scope or visibility change (4464, D-30) close the guest's views so they reconnect to a fresh `ready`
// under the new rights: one path up and down, nothing to patch view by view.
//
// No Electron import: every effect goes through deps (index.ts wires them, task 07), so the unit tests
// drive the whole lifecycle with fakes and a fake clock.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { isPlainObject } from '../../shared/guards'
import { tabVisible as tabVisibleRule } from '../../shared/guest-filter'
import {
  GUEST_NAME_MAX,
  INVITE_TOKEN_CHARS,
  INVITE_UNUSED_MS,
  MAX_GUESTS,
  guestLifetimeOf,
  guestRoleOf,
  guestScopeOf,
  guestUntil,
  type GuestAccess,
  type GuestInviteAnswer,
  type GuestInviteRequest,
  type GuestRecord,
  type GuestRole,
  type GuestScope,
  type GuestView,
  type InviteRecord
} from '../../shared/guests'
import type { WebAccessMode } from '../../shared/types'
import { CLOSE, inviteLink, type WebInviteError } from '../../shared/web-protocol'
import { isRemoteViewId, type ViewId, type Who } from '../../shared/views'
import type { GuestService } from '../ipc/guest-deps'
import { plainText, type AccessLog } from './access-log'
import { cookieFingerprint, isGuestId, type DeviceStore, type WebDevice } from './devices'

/** How long an ended guest's cookie is recognised as "ended" rather than unknown (D-32). */
export const ENDED_TOMBSTONE_MS = 7 * 24 * 3600_000
/** Tombstones kept at most (oldest dropped first): bounded whatever the churn. */
export const MAX_ENDED_TOMBSTONES = 128
/** Spent invite hashes kept (so a second redeem says `used`, not `invalid`), each until its invite would have expired. */
export const MAX_SPENT_INVITES = 128
/** How often lifetimes and unused invites are swept (a missed end is at most this late; `access` also checks `until`). */
export const SWEEP_MS = 30_000
/** A guest with no live view that left within this long is `away` in the owner's list, else `offline`. */
export const AWAY_MS = 60 * 60_000

/** The parts of a tab the store reads (TabManager's own record, task 07 wires it). */
export interface GuestTabInfo {
  projectId: string
  /** A plugin command tab: the plugin that opened it. */
  openedBy?: string
  /** A page tab: its plugin. */
  page?: { plugin: string }
}

/** Where invite links point, from the web access settings (auth.ts `linkOrigin`). */
export interface InviteTarget {
  origin: string
  /** Web access listens on loopback with no external origin: nobody else can open the link yet (D-35). */
  loopbackOnly: boolean
  /** SHA-256 hex of the TLS certificate's DER when the gateway serves TLS (D-29: the guest's app pins it). */
  certPin?: string
}

export interface GuestStoreDeps {
  devices: Pick<
    DeviceStore,
    'add' | 'hasRoom' | 'devicesOfGuest' | 'revokeGuest' | 'secretHashOf' | 'guestSection' | 'setGuestSection' | 'onDropped'
  >
  accessLog: Pick<AccessLog, 'write'>
  /** The owner's sign-in mode now (WebAuth.mode). */
  mode(): WebAccessMode | undefined
  target(): InviteTarget
  /** Whether the project's guests see the plugin (PluginGuestAccessService.visible, task 04). Absent: no plugin is. */
  pluginShown?(projectId: string, pluginId: string): boolean
  /** Whether the plugin is on in the project (a plugin that is off shows nobody anything). Absent: true. */
  pluginEnabled?(projectId: string, pluginId: string): boolean
  /** A live tab of any project (TabManager). */
  tabOf(tabId: string): GuestTabInfo | undefined
  /** Who is behind a live remote view (WebConnections / ViewRegistry `whoOf`); undefined: gone. */
  whoOfView(viewId: ViewId): Who | undefined
  /** Close every view of the guest with `code` (WebConnections.closeGuest); the count closed. */
  closeGuestViews(guestId: string, code: number, reason: string): number
  /** Whether the guest has a bound view now. */
  guestLive(guestId: string): boolean
  /** The guest's devices' plugin page tokens die (PluginPages.tokens.dropDevice, D-30). */
  dropPageTokens?(deviceId: string): void
  /** Titles of this guest's page tabs with unsaved changes (TabManager's per (tab, view) dirty). Absent: none. */
  unsavedOf?(guestId: string): string[]
  /** A notice to the owner ("Bob joined"): core notices. Absent: none. */
  notify?(text: string): void
  log(message: string): void
  now?: () => number
  setInterval?: (fn: () => void, ms: number) => { stop(): void }
}

/** What `/auth/invite` answers (gateway.ts): a status, the body, and on success the device cookie and key. */
export type RedeemResult =
  | { ok: true; status: 200; cookie: string; key: string; device: WebDevice; project: string }
  | { ok: false; status: 400 | 404 | 409 | 410 | 503; error: WebInviteError }

interface SpentInvite {
  hash: string
  until: number
}

interface EndedGuest {
  deviceId: string
  secretHash: string
  until: number
}

interface GuestSection {
  v: 1
  invites: InviteRecord[]
  guests: GuestRecord[]
  spent: SpentInvite[]
  ended: EndedGuest[]
}

const isHex64 = (v: unknown): v is string =>
  typeof v === 'string' && v.length === 64 && [...v].every((c) => (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
const isId = (v: unknown): v is string => isGuestId(v)
const idList = (v: unknown): string[] | undefined => {
  if (!Array.isArray(v) || v.length > 256) return undefined
  return v.every((x) => typeof x === 'string' && x.length > 0 && x.length <= 128) ? [...new Set(v as string[])] : undefined
}

/** A guest's or invite's name: the owner's own text, plain, bounded; empty when nothing is left. */
export function guestName(raw: unknown): string {
  return typeof raw === 'string' ? plainText(raw, GUEST_NAME_MAX) : ''
}

function inviteOf(raw: unknown): InviteRecord | undefined {
  if (!isPlainObject(raw)) return undefined
  const { id, hash, guestId, name, role, projectId, scope, lifetime, createdAt, expiresAt } = raw
  const r = guestRoleOf(role)
  const s = guestScopeOf(scope)
  const l = guestLifetimeOf(lifetime)
  const n = guestName(name)
  if (!isId(id) || !isHex64(hash) || !isId(guestId) || n === '' || !r || !s || !l) return undefined
  if (typeof projectId !== 'string' || projectId.length === 0 || projectId.length > 128 || !isTime(createdAt) || !isTime(expiresAt)) return undefined
  return { id, hash, guestId, name: n, role: r, projectId, scope: s, lifetime: l, createdAt, expiresAt }
}

function guestOf(raw: unknown): GuestRecord | undefined {
  if (!isPlainObject(raw)) return undefined
  const { id, name, role, projectId, scope, createdAt, until, openedTabs } = raw
  const r = guestRoleOf(role)
  const s = guestScopeOf(scope)
  const n = guestName(name)
  const opened = idList(openedTabs ?? [])
  if (!isId(id) || n === '' || !r || !s || !opened) return undefined
  if (typeof projectId !== 'string' || projectId.length === 0 || projectId.length > 128 || !isTime(createdAt)) return undefined
  if (until !== null && !isTime(until)) return undefined
  return { id, name: n, role: r, projectId, scope: s, createdAt, until, openedTabs: opened }
}

function sectionOf(raw: unknown): GuestSection {
  const out: GuestSection = { v: 1, invites: [], guests: [], spent: [], ended: [] }
  if (!isPlainObject(raw)) return out
  // Tolerant per record, as devices.ts: one damaged entry costs that entry, not the others.
  for (const i of Array.isArray(raw.invites) ? raw.invites : []) {
    const r = inviteOf(i)
    if (r && !out.invites.some((x) => x.id === r.id || x.guestId === r.guestId)) out.invites.push(r)
  }
  for (const g of Array.isArray(raw.guests) ? raw.guests : []) {
    const r = guestOf(g)
    if (r && !out.guests.some((x) => x.id === r.id)) out.guests.push(r)
  }
  for (const s of Array.isArray(raw.spent) ? raw.spent : []) {
    if (isPlainObject(s) && isHex64(s.hash) && isTime(s.until)) out.spent.push({ hash: s.hash, until: s.until })
  }
  for (const e of Array.isArray(raw.ended) ? raw.ended : []) {
    if (isPlainObject(e) && typeof e.deviceId === 'string' && e.deviceId.length <= 64 && isHex64(e.secretHash) && isTime(e.until)) {
      out.ended.push({ deviceId: e.deviceId, secretHash: e.secretHash, until: e.until })
    }
  }
  out.spent = out.spent.slice(-MAX_SPENT_INVITES)
  out.ended = out.ended.slice(-MAX_ENDED_TOMBSTONES)
  return out
}

/** Lowercase hex SHA-256 of an invite token (what the store keeps). */
export function inviteHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/** Constant time on equal-length hex strings (a hash is never compared byte by byte with early exit). */
function sameHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex')
  const y = Buffer.from(b, 'hex')
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y)
}

function isInviteToken(v: unknown): v is string {
  if (typeof v !== 'string' || v.length !== INVITE_TOKEN_CHARS) return false
  for (const ch of v) {
    const ok = (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch === '-' || ch === '_'
    if (!ok) return false
  }
  return true
}

/** Why a guest ended, as the log says it and as its views are closed. */
type EndWhy = 'kicked' | 'revoked' | 'expired' | 'lifetime' | 'project-removed'

const END_CODE: Record<EndWhy, number> = {
  kicked: CLOSE.kicked,
  revoked: CLOSE.kicked,
  'project-removed': CLOSE.kicked,
  expired: CLOSE.accessEnded,
  lifetime: CLOSE.accessEnded
}

export class GuestStore implements GuestService {
  private data: GuestSection
  private readonly now: () => number
  private readonly listeners = new Set<() => void>()
  /** When each guest's last view left (in memory: the list's `away`). */
  private readonly leftAt = new Map<string, number>()
  private readonly sweeper: { stop(): void } | undefined
  /** Guests being ended now: a device revoke inside `end` reaches `dropped` and must not end them twice. */
  private readonly ending = new Set<string>()

  constructor(private readonly deps: GuestStoreDeps) {
    this.now = deps.now ?? Date.now
    this.data = sectionOf(deps.devices.guestSection())
    // A guest whose device is gone (pruned while the app was off, a hand edit) can never come back (D-20):
    // dropped now. One whose lifetime ended meanwhile goes in the first sweep.
    const before = this.data.guests.length
    this.data.guests = this.data.guests.filter((g) => deps.devices.devicesOfGuest(g.id).length > 0)
    if (before !== this.data.guests.length) this.save()
    deps.devices.onDropped((gone, event, secretHashOf) => this.dropped(gone, event, secretHashOf))
    const every = deps.setInterval ?? ((fn, ms) => {
      const t = setInterval(fn, ms)
      t.unref?.()
      return { stop: () => clearInterval(t) }
    })
    this.sweeper = every(() => this.sweep(), SWEEP_MS)
    this.sweep()
  }

  dispose(): void {
    this.sweeper?.stop()
  }

  // -------------------------------------------------------------------------------------------
  // Live answers

  access(who: Who): GuestAccess {
    if (who === 'owner') return { kind: 'owner' }
    const g = this.live(who.guest)
    return g ? { kind: 'guest', id: g.id, name: g.name, role: g.role, projectId: g.projectId, scope: g.scope } : { kind: 'revoked' }
  }

  whoAccess(viewId: ViewId): GuestAccess {
    // A desktop window's own view is the person at the machine.
    if (!isRemoteViewId(viewId)) return { kind: 'owner' }
    const who = this.deps.whoOfView(viewId)
    return who === undefined ? { kind: 'revoked' } : this.access(who)
  }

  tabVisible(guestId: string, tabId: string): boolean {
    const g = this.live(guestId)
    if (!g) return false
    const tab = this.deps.tabOf(tabId)
    // Another project's tab is never in a guest's scope, whatever its id.
    if (!tab || tab.projectId !== g.projectId) return false
    const input = { id: tabId, ...(tab.openedBy !== undefined ? { openedBy: tab.openedBy } : {}), ...(tab.page ? { page: tab.page } : {}) }
    return tabVisibleRule(this.access({ guest: guestId }), input, g.openedTabs, (p) => this.pluginVisible(g.projectId, p))
  }

  pluginVisible(projectId: string, pluginId: string): boolean {
    try {
      if (this.deps.pluginEnabled && !this.deps.pluginEnabled(projectId, pluginId)) return false
      return this.deps.pluginShown?.(projectId, pluginId) === true
    } catch (err) {
      // Fail closed: a lookup that throws shows a guest nothing.
      this.deps.log(`guests: plugin visibility failed: ${String(err)}`)
      return false
    }
  }

  openedTabs(guestId: string): readonly string[] {
    return this.live(guestId)?.openedTabs ?? []
  }

  noteOpenedTab(guestId: string, tabId: string): void {
    const g = this.live(guestId)
    if (!g || g.openedTabs.includes(tabId)) return
    g.openedTabs.push(tabId)
    this.save()
    this.changed()
  }

  /** Every guest of a project (the project's views, presence). */
  guestsOf(projectId: string): GuestRecord[] {
    return this.data.guests.filter((g) => g.projectId === projectId && this.isLive(g)).map((g) => ({ ...g, openedTabs: [...g.openedTabs] }))
  }

  /** A guest's record (its devices' views read the name at `hello`). */
  guest(guestId: string): GuestRecord | undefined {
    const g = this.live(guestId)
    return g ? { ...g, openedTabs: [...g.openedTabs] } : undefined
  }

  list(): GuestView[] {
    const now = this.now()
    const out: GuestView[] = []
    for (const g of this.data.guests) {
      if (!this.isLive(g)) continue
      const live = this.safeLive(g.id)
      const left = this.leftAt.get(g.id)
      const state: GuestView['state'] = live ? 'live' : left !== undefined && now - left < AWAY_MS ? 'away' : 'offline'
      const row: GuestView = { id: g.id, name: g.name, role: g.role, projectId: g.projectId, scope: g.scope, state, until: g.until }
      const unsaved = this.unsaved(g.id)
      if (unsaved.length > 0) row.unsaved = unsaved
      out.push(row)
    }
    for (const i of this.data.invites) {
      if (i.expiresAt <= now) continue
      out.push({
        id: i.guestId,
        name: i.name,
        role: i.role,
        projectId: i.projectId,
        scope: i.scope,
        state: 'pending',
        until: null,
        inviteId: i.id,
        inviteExpiresAt: i.expiresAt
      })
    }
    return out
  }

  unsaved(guestId: string): string[] {
    try {
      return this.deps.unsavedOf?.(guestId) ?? []
    } catch {
      return []
    }
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** The names of every live guest and pending invite: what keeps the owner from switching to None (D-15). */
  blockingNone(): string[] {
    return this.list().map((v) => (v.state === 'pending' ? `${v.name} (invited)` : v.name))
  }

  /** A guest's view joined or left (WebConnections): the owner's list shows live / away. */
  viewsChanged(guestId: string, live: boolean): void {
    if (!live) this.leftAt.set(guestId, this.now())
    this.changed()
  }

  // -------------------------------------------------------------------------------------------
  // Invites

  async invite(projectId: string, req: GuestInviteRequest): Promise<GuestInviteAnswer> {
    const name = guestName(req?.name)
    const role = guestRoleOf(req?.role)
    const lifetime = guestLifetimeOf(req?.lifetime)
    let scope = guestScopeOf(req?.scope)
    // A malformed request is a bug or a hostile page, not a choice the dialog offers: thrown, not answered.
    if (name === '' || !role || !lifetime || !scope) throw new Error('guests.invite: bad request')
    if (this.deps.mode() === 'none') return { ok: false, error: 'none-mode' }
    const key = name.toLowerCase()
    if (this.list().some((v) => v.name.toLowerCase() === key)) return { ok: false, error: 'name-taken' }
    if (this.list().length >= MAX_GUESTS) return { ok: false, error: 'cap' }
    if (!this.deps.devices.hasRoom()) return { ok: false, error: 'full' }
    // Selected tabs: only the project's own live tabs (an id of another project's tab means nothing here).
    if (scope !== 'all') scope = scope.filter((t) => this.deps.tabOf(t)?.projectId === projectId)
    const token = randomBytes(32).toString('base64url')
    const now = this.now()
    const invite: InviteRecord = {
      id: randomBytes(12).toString('base64url'),
      hash: inviteHash(token),
      guestId: randomBytes(12).toString('base64url'),
      name,
      role,
      projectId,
      scope,
      lifetime,
      createdAt: now,
      expiresAt: now + INVITE_UNUSED_MS
    }
    const target = this.deps.target()
    this.data.invites.push(invite)
    this.save()
    this.deps.accessLog.write({ event: 'guest', name, detail: `invite ${role}` })
    this.changed()
    const answer: GuestInviteAnswer = {
      ok: true,
      link: inviteLink(target.origin, token, target.certPin),
      inviteId: invite.id,
      guestId: invite.guestId,
      expiresAt: invite.expiresAt
    }
    if (target.loopbackOnly) answer.warning = 'loopback-only'
    return answer
  }

  revokeInvite(inviteId: string): boolean {
    const before = this.data.invites.length
    this.data.invites = this.data.invites.filter((i) => i.id !== inviteId)
    if (this.data.invites.length === before) return false
    this.save()
    this.changed()
    return true
  }

  /**
   * `POST /auth/invite` (gateway.ts, after the Host and Origin checks, inside its own attempt bucket, D-19).
   * Synchronous from the first check to the spend, so two parallel redeems of one link make one device.
   * `ownerDevice`: the request already signs in an owner device (its cookie and key): refused, or the
   * redeem would replace the owner's cookie in that browser (design §3, "open it in a private window").
   */
  redeem(body: unknown, opts: { ownerDevice: boolean }): RedeemResult {
    const token = isPlainObject(body) ? body.token : undefined
    if (!isInviteToken(token)) return { ok: false, status: 400, error: 'bad-request' }
    if (this.deps.mode() === 'none') return { ok: false, status: 409, error: 'none-mode' }
    if (opts.ownerDevice) return { ok: false, status: 409, error: 'owner-device' }
    const hash = inviteHash(token)
    const now = this.now()
    const invite = this.data.invites.find((i) => sameHex(i.hash, hash))
    if (!invite) {
      return this.data.spent.some((s) => sameHex(s.hash, hash) && s.until > now)
        ? { ok: false, status: 410, error: 'used' }
        : { ok: false, status: 404, error: 'invalid' }
    }
    if (invite.expiresAt <= now) {
      this.data.invites = this.data.invites.filter((i) => i !== invite)
      this.save()
      this.changed()
      return { ok: false, status: 410, error: 'expired' }
    }
    // Before the spend: a full store leaves the invite good for later (the owner revokes a device).
    if (!this.deps.devices.hasRoom()) return { ok: false, status: 503, error: 'full' }
    const made = this.deps.devices.add(invite.name, 'guest', invite.guestId)
    if (!made) return { ok: false, status: 503, error: 'full' }
    this.data.invites = this.data.invites.filter((i) => i !== invite)
    this.data.spent.push({ hash: invite.hash, until: invite.expiresAt })
    this.data.spent = this.data.spent.slice(-MAX_SPENT_INVITES)
    this.data.guests.push({
      id: invite.guestId,
      name: invite.name,
      role: invite.role,
      projectId: invite.projectId,
      scope: invite.scope,
      createdAt: now,
      until: guestUntil(invite.lifetime, now),
      openedTabs: []
    })
    this.save()
    this.deps.accessLog.write({ event: 'guest', device: made.device.id, name: invite.name, detail: `joined ${invite.role}` })
    this.deps.notify?.(`${invite.name} joined as a ${invite.role === 'read' ? 'read-only' : 'write'} guest`)
    this.changed()
    return { ok: true, status: 200, cookie: made.cookie, key: made.key, device: made.device, project: invite.projectId }
  }

  /**
   * Whether a `Cookie` header carries an ended guest's device cookie (D-32): `/auth/session` then answers
   * `guestEnded` so the page says "your access ended". The cookie's secret is hashed and compared in
   * constant time against the tombstones of the same device id; nothing is revealed about live devices.
   */
  endedCookie(values: readonly string[]): boolean {
    const now = this.now()
    for (const value of values) {
      const fp = cookieFingerprint(value)
      if (!fp) continue
      for (const e of this.data.ended) if (e.deviceId === fp.id && e.until > now && sameHex(e.secretHash, fp.secretHash)) return true
    }
    return false
  }

  // -------------------------------------------------------------------------------------------
  // The owner's controls

  kick(guestId: string): boolean {
    if (this.live(guestId)) {
      this.end(guestId, 'kicked')
      return true
    }
    // A pending invite's guest id (the list shows it before the redeem): the invite goes.
    const invite = this.data.invites.find((i) => i.guestId === guestId)
    return invite ? this.revokeInvite(invite.id) : false
  }

  setRole(guestId: string, role: GuestRole): boolean {
    const g = this.live(guestId)
    if (!g || guestRoleOf(role) === undefined) return false
    if (g.role === role) return true
    g.role = role
    this.save()
    this.deps.accessLog.write({ event: 'guest', name: g.name, detail: `role ${role}` })
    // Every view of the guest reconnects under the new role (new view ids: a view's access never changes in its life).
    this.reconnect(g.id, CLOSE.roleChanged, 'role changed')
    this.changed()
    return true
  }

  setScope(guestId: string, scope: GuestScope): boolean {
    const g = this.live(guestId)
    const s = guestScopeOf(scope)
    if (!g || !s) return false
    g.scope = s === 'all' ? 'all' : s.filter((t) => this.deps.tabOf(t)?.projectId === g.projectId || (g.scope !== 'all' && g.scope.includes(t)))
    this.save()
    this.deps.accessLog.write({ event: 'guest', name: g.name, detail: 'scope' })
    this.accessChangedFor(g.id)
    this.changed()
    return true
  }

  shareTab(guestId: string, tabId: string, shared: boolean): boolean {
    const g = this.live(guestId)
    if (!g || g.scope === 'all') return false
    const tab = this.deps.tabOf(tabId)
    if (shared && tab?.projectId !== g.projectId) return false
    const has = g.scope.includes(tabId)
    if (has === shared) return true
    g.scope = shared ? [...g.scope, tabId] : g.scope.filter((t) => t !== tabId)
    this.save()
    this.accessChangedFor(g.id)
    this.changed()
    return true
  }

  remap(projectId: string, idMap: ReadonlyMap<string, string>): void {
    let touched = false
    const map = (ids: readonly string[]): string[] => ids.map((t) => idMap.get(t) ?? t)
    for (const g of this.data.guests) {
      if (g.projectId !== projectId) continue
      if (g.scope !== 'all') g.scope = [...new Set(map(g.scope))]
      g.openedTabs = [...new Set(map(g.openedTabs))]
      touched = true
    }
    for (const i of this.data.invites) {
      if (i.projectId !== projectId || i.scope === 'all') continue
      i.scope = [...new Set(map(i.scope))]
      touched = true
    }
    if (touched) {
      this.save()
      this.changed()
    }
  }

  /**
   * A plugin's guest visibility (or its being on in a project) changed (PluginGuestAccessService.onChange, task
   * 04): every live guest of `projectId` (all projects when absent) reconnects to a fresh `ready` (D-30), its
   * page tokens dropped, so no port, page, webview or overlay of a plugin it can no longer see stays open.
   */
  pluginAccessChanged(projectId?: string): void {
    for (const g of this.data.guests) if (this.isLive(g) && (projectId === undefined || g.projectId === projectId)) this.accessChangedFor(g.id)
  }

  /** A project was forgotten (removed from the registry): its guests end; their invites go (design §14). */
  projectRemoved(projectId: string): void {
    for (const g of [...this.data.guests]) if (g.projectId === projectId) this.end(g.id, 'project-removed')
    const before = this.data.invites.length
    this.data.invites = this.data.invites.filter((i) => i.projectId !== projectId)
    if (before !== this.data.invites.length) {
      this.save()
      this.changed()
    }
  }

  // -------------------------------------------------------------------------------------------
  // Internals

  /** A guest record that is live now (exists and its lifetime has not ended). */
  private live(guestId: string): GuestRecord | undefined {
    const g = this.data.guests.find((x) => x.id === guestId)
    return g && this.isLive(g) ? g : undefined
  }

  private isLive(g: GuestRecord): boolean {
    return (g.until === null || g.until > this.now()) && !this.ending.has(g.id)
  }

  private safeLive(guestId: string): boolean {
    try {
      return this.deps.guestLive(guestId)
    } catch {
      return false
    }
  }

  private reconnect(guestId: string, code: number, reason: string): void {
    try {
      this.deps.closeGuestViews(guestId, code, reason)
    } catch (err) {
      this.deps.log(`guests: closing a guest's views failed: ${String(err)}`)
    }
  }

  /** D-30: the guest's views reconnect and its page tokens die. */
  private accessChangedFor(guestId: string): void {
    for (const d of this.deps.devices.devicesOfGuest(guestId)) {
      try {
        this.deps.dropPageTokens?.(d.id)
      } catch (err) {
        this.deps.log(`guests: dropping page tokens failed: ${String(err)}`)
      }
    }
    this.reconnect(guestId, CLOSE.accessChanged, 'access changed')
  }

  /**
   * The one way a guest ends. Its views close first with the code its page shows (a device revoke alone
   * closes them as "signed out"), then its devices are revoked (the gateway drops their sockets, page
   * tokens and downloads), their cookies tombstoned, the record and any invite for it removed.
   */
  private end(guestId: string, why: EndWhy, gone: ReadonlyArray<{ deviceId: string; secretHash: string }> = []): void {
    const g = this.data.guests.find((x) => x.id === guestId)
    if (!g || this.ending.has(guestId)) return
    this.ending.add(guestId)
    try {
      this.reconnect(guestId, END_CODE[why], why)
      const now = this.now()
      // Tombstones for the devices still live (a kick, a lifetime) and for those already gone (a revoke in the
      // device list, Revoke all, an idle expiry: `dropped` hands their hashes in), so every end says "ended".
      const stones = [...gone]
      for (const d of this.deps.devices.devicesOfGuest(guestId)) {
        const secretHash = this.deps.devices.secretHashOf(d.id)
        if (secretHash !== undefined) stones.push({ deviceId: d.id, secretHash })
      }
      for (const s of stones) this.data.ended.push({ deviceId: s.deviceId, secretHash: s.secretHash, until: now + ENDED_TOMBSTONE_MS })
      this.data.ended = this.data.ended.slice(-MAX_ENDED_TOMBSTONES)
      this.data.guests = this.data.guests.filter((x) => x.id !== guestId)
      this.data.invites = this.data.invites.filter((i) => i.guestId !== guestId)
      this.leftAt.delete(guestId)
      this.save()
      this.deps.devices.revokeGuest(guestId, `guest ended: ${why}`)
      this.deps.accessLog.write({ event: 'guest', name: g.name, detail: `ended: ${why}` })
    } finally {
      this.ending.delete(guestId)
    }
    this.changed()
  }

  /** Devices revoked or expired elsewhere (the device list, Revoke all, idle expiry): their guests end. */
  private dropped(gone: readonly WebDevice[], event: 'revoke' | 'expired', secretHashOf: (id: string) => string | undefined): void {
    for (const d of gone) {
      if (d.guestId === undefined || this.ending.has(d.guestId)) continue
      if (!this.data.guests.some((g) => g.id === d.guestId)) continue
      if (this.deps.devices.devicesOfGuest(d.guestId).length > 0) continue
      const stones = gone.flatMap((x) => {
        const secretHash = x.guestId === d.guestId ? secretHashOf(x.id) : undefined
        return secretHash === undefined ? [] : [{ deviceId: x.id, secretHash }]
      })
      this.end(d.guestId, event === 'expired' ? 'expired' : 'revoked', stones)
    }
  }

  /** Lifetimes over, unused invites past 24 h, spent hashes and tombstones past their time. */
  sweep(): void {
    const now = this.now()
    for (const g of [...this.data.guests]) if (g.until !== null && g.until <= now) this.end(g.id, 'lifetime')
    const sizes = [this.data.invites.length, this.data.spent.length, this.data.ended.length]
    this.data.invites = this.data.invites.filter((i) => i.expiresAt > now)
    this.data.spent = this.data.spent.filter((s) => s.until > now)
    this.data.ended = this.data.ended.filter((e) => e.until > now)
    if (sizes[0] !== this.data.invites.length || sizes[1] !== this.data.spent.length || sizes[2] !== this.data.ended.length) {
      this.save()
      if (sizes[0] !== this.data.invites.length) this.changed()
    }
  }

  private save(): void {
    this.deps.devices.setGuestSection(this.data)
  }

  private changed(): void {
    for (const l of this.listeners) {
      try {
        l()
      } catch {
        // A listener's failure must not undo the change it hears about.
      }
    }
  }
}
