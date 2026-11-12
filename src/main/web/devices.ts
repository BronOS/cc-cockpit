// Signed-in browsers of web access (design-web.md §4.1 "Device cookie", "Visible on the desktop").
//
// `<data>/web-access.json` (the app data dir, not `app.json`: a settings file is something people
// copy between machines and paste into bug reports, this one holds credentials):
// `{ schemaVersion, devices: DeviceRecord[], accessToken? }`.
//
//  - A device is `{ id, name, createdAt, lastSeenAt, secretHash, keyHash, mode }`. Its cookie is
//    `<id>.<secret>`: 256 random bits of secret, stored only as its SHA-256 (a fast hash is enough
//    for a random secret; scrypt is for passwords, plan Task 27). Checked in constant time.
//  - Its origin key (design-web.md §4.1 "Origin-bound device"): a second 256-bit secret made at the
//    same sign-in, stored only as `keyHash`. The cookie alone no longer signs a device in: cookies are
//    not port-scoped, so any other server on the same host a browser visits receives the cookie and
//    could replay it with a forged Host and Origin. The key travels apart from the cookie (the page
//    keeps it in its origin's localStorage, which is port-scoped, and sends it as a header or a
//    WebSocket subprotocol, auth.ts), so a cookie that leaked to another port is worth nothing there.
//    A record from before the key existed has none: it is dropped when the file is read (logged as a
//    revoke), and that browser signs in again.
//  - Sliding expiry: a device unused for 30 days is gone (dropped when it next shows up, and from
//    the list). The cookie is never rotated: a rotation races a device's parallel requests and its
//    open sockets, which cannot take a `Set-Cookie`. `lastSeenAt` moves at most once a minute, so
//    a busy page does not rewrite the file. An open socket is use too: a tab left connected for a
//    month makes no request, so the gateway reports its sockets (`socketOpened`/`socketClosed`), a
//    connected device never expires, and it counts as seen whenever the store looks (list, add,
//    a check, the close, quit).
//  - Revoke, revoke all, and revoke every device a sign-in method let in (regenerating the access
//    link, auth.ts). Revoking tells the listeners at once (the gateway closes the device's sockets;
//    plugin-page tokens die with them, plan Task 20), and is flushed to disk before it returns.
//  - A new device raises a desktop notification (through the notifier adapter main passes in).
//  - The access token's record (auth.ts) lives here too, so web access has one credentials file:
//    its hash for sign-in checks and its secret-store ciphertext for the desktop's Show button.
//  - So does the password's (plan Task 27): its scrypt hash (password.ts), stored only as the secret
//    store's ciphertext, so a copy of this file alone cannot be used to guess the password offline.
//
// Device names are the requester's own text (access-log.ts plainText): shown as plain text,
// never as markup. No `electron` import; the file goes through JsonFile like every state file.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { isPlainObject } from '../../shared/guards'
import { JsonFile, type FsOps } from '../store/json-file'
import { plainText, type AccessActor, type AccessLog } from './access-log'

/** 30 days without use and a device is gone. */
export const DEVICE_IDLE_MS = 30 * 24 * 60 * 60 * 1000
/** `lastSeenAt` is written at most this often per device. */
export const TOUCH_INTERVAL_MS = 60 * 1000
/** A cap so a leaked link cannot grow the file without end; the person revokes old ones. */
export const MAX_DEVICES = 64
export const MAX_DEVICE_NAME = 60
export const DEFAULT_DEVICE_NAME = 'Browser'

/** How a device signed in: the access link, a one-time "add a device" link, a password, a desktop confirm. */
export type DeviceSignIn = 'link' | 'add' | 'password' | 'confirm'

export interface DeviceRecord {
  id: string
  name: string
  createdAt: number
  lastSeenAt: number
  /** Hex SHA-256 of the cookie's secret part. */
  secretHash: string
  /** Hex SHA-256 of the origin key (see the header): the cookie is good only with it. */
  keyHash: string
  mode: DeviceSignIn
}

/** A device as the rest of main sees it: no hash. `mode: 'none'` is the anonymous None-mode caller (auth.ts). */
export interface WebDevice {
  id: string
  name: string
  createdAt: number
  lastSeenAt: number
  mode: DeviceSignIn | 'none'
}

/** The access link's token (auth.ts): its hash, and the secret store's ciphertext of it. */
export interface AccessTokenRecord {
  hash: string
  stored: string
  createdAt: number
}

/** The password (auth.ts): the secret store's ciphertext of its scrypt hash (password.ts). */
export interface PasswordRecord {
  stored: string
  createdAt: number
  /**
   * The password has at least MIN_NETWORK_PASSWORD_LENGTH characters (password.ts): set when it is
   * set, and learned at the next good sign-in for one set before the rule (absent until then). Only
   * this bit is kept, never the length, so the settings can say "too short for a network".
   */
  long?: boolean
}

interface WebAccessFileData {
  schemaVersion: number
  devices: DeviceRecord[]
  accessToken?: AccessTokenRecord
  password?: PasswordRecord
}

const SIGN_INS: readonly DeviceSignIn[] = ['link', 'add', 'password', 'confirm']
/** The stand-in hash an unknown id is compared against (no secret hashes to all zeros). */
const DUMMY_HASH = '0'.repeat(64)

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex')
}

/** Constant-time: whether `given` hashes to `hash` (hex SHA-256). Neither content nor length leaks. */
export function matchesHash(given: string, hash: string): boolean {
  const a = createHash('sha256').update(given, 'utf8').digest()
  const b = Buffer.from(hash, 'hex')
  if (b.length !== a.length) {
    // A damaged stored hash (wrong length) still costs one compare, so it takes the same time.
    timingSafeEqual(a, a)
    return false
  }
  return timingSafeEqual(a, b)
}

/** 256 random bits, base64url (43 characters): device secrets and access tokens. */
export function randomSecret(): string {
  return randomBytes(32).toString('base64url')
}

function isBase64Url(text: string): boolean {
  for (const ch of text) {
    const ok = (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch === '-' || ch === '_'
    if (!ok) return false
  }
  return text.length > 0
}

function isHex64(text: unknown): text is string {
  if (typeof text !== 'string' || text.length !== 64) return false
  for (const ch of text) if (!((ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f'))) return false
  return true
}

/**
 * A stored record, or undefined when a hand edit damaged it (it is dropped, never half-trusted).
 * `unkeyed`: a whole record from before the origin key (no `keyHash`), which the store drops with a
 * log line of its own.
 */
function recordOf(raw: unknown): DeviceRecord | { unkeyed: { id: string; name: string } } | undefined {
  if (!isPlainObject(raw)) return undefined
  const { id, name, createdAt, lastSeenAt, secretHash, keyHash, mode } = raw
  if (typeof id !== 'string' || id.length > 64 || !isBase64Url(id)) return undefined
  if (typeof name !== 'string' || !isHex64(secretHash)) return undefined
  if (typeof createdAt !== 'number' || typeof lastSeenAt !== 'number' || !Number.isFinite(createdAt) || !Number.isFinite(lastSeenAt)) return undefined
  const how = SIGN_INS.find((m) => m === mode)
  if (how === undefined) return undefined
  if (keyHash === undefined) return { unkeyed: { id, name: deviceName(name) } }
  if (!isHex64(keyHash)) return undefined
  return { id, name: deviceName(name), createdAt, lastSeenAt, secretHash, keyHash, mode: how }
}

/** What a device's record was dropped for when it had no origin key (web-access.log's reason). */
export const UNKEYED_REASON = 'signed in before devices were bound to their origin; sign in again'

/** Most origin keys one request may offer (its header, or its subprotocols on the upgrade); the rest are not tried. */
export const MAX_OFFERED_KEYS = 8

/** The name a device is listed under: the requester's text made plain, or the default. */
export function deviceName(raw: unknown): string {
  const name = typeof raw === 'string' ? plainText(raw, MAX_DEVICE_NAME) : ''
  return name === '' ? DEFAULT_DEVICE_NAME : name
}

function publicOf(record: DeviceRecord): WebDevice {
  return { id: record.id, name: record.name, createdAt: record.createdAt, lastSeenAt: record.lastSeenAt, mode: record.mode }
}

/** `<id>.<secret>` split, or undefined when it is not that shape. */
function cookieParts(value: string): { id: string; secret: string } | undefined {
  const dot = value.indexOf('.')
  if (dot <= 0 || value.length > 200) return undefined
  const id = value.slice(0, dot)
  const secret = value.slice(dot + 1)
  return isBase64Url(id) && isBase64Url(secret) ? { id, secret } : undefined
}

export interface DeviceStoreOptions {
  /** `<data>/web-access.json`. */
  filePath: string
  accessLog: AccessLog
  /** Tells of a new device (main: core notices); `device` is its id, the one its `web-access.log` sign-in carries. */
  notify?: (text: string, device: string) => void
  now?: () => number
  fs?: FsOps
  log?: (message: string) => void
}

export type RevokedListener = (ids: readonly string[]) => void

export class DeviceStore {
  private readonly file: JsonFile<WebAccessFileData>
  private readonly accessLog: AccessLog
  private readonly notify: (text: string, device: string) => void
  private readonly now: () => number
  private readonly listeners = new Set<RevokedListener>()
  private readonly changeListeners = new Set<() => void>()
  /** Open sockets per device id (the gateway's reports). In memory only: none survive a restart. */
  private readonly open = new Map<string, number>()

  constructor(options: DeviceStoreOptions) {
    this.accessLog = options.accessLog
    this.notify = options.notify ?? (() => undefined)
    this.now = options.now ?? Date.now
    this.file = new JsonFile<WebAccessFileData>({
      filePath: options.filePath,
      defaults: () => ({ schemaVersion: 1, devices: [] }),
      ...(options.fs ? { fs: options.fs } : {}),
      ...(options.log ? { log: options.log } : {}),
      now: this.now
    })
    // Tolerant per record: one damaged entry costs that device, not the others.
    const data = this.file.data
    const devices: DeviceRecord[] = []
    const unkeyed: { id: string; name: string }[] = []
    for (const raw of Array.isArray(data.devices) ? data.devices : []) {
      const record = recordOf(raw)
      if (record === undefined) continue
      if ('unkeyed' in record) unkeyed.push(record.unkeyed)
      else devices.push(record)
    }
    data.devices = devices
    const token = data.accessToken
    if (token !== undefined && !(isPlainObject(token) && isHex64(token.hash) && typeof token.stored === 'string' && typeof token.createdAt === 'number')) {
      delete data.accessToken
    }
    const password = data.password
    if (password !== undefined && !(isPlainObject(password) && typeof password.stored === 'string' && typeof password.createdAt === 'number')) {
      delete data.password
    } else if (password !== undefined && password.long !== undefined && typeof password.long !== 'boolean') {
      delete password.long
    }
    // Devices from before the origin key: their cookie alone would sign them in, which is what the key
    // ends. Gone on disk now (a credential), each with a revoke line saying why; nobody listens yet.
    if (unkeyed.length > 0) {
      this.commit()
      for (const d of unkeyed) this.accessLog.write({ event: 'revoke', device: d.id, name: d.name, detail: UNKEYED_REASON })
    }
  }

  /** Called with the ids of every device revoked or expired (the gateway closes their sockets). */
  onRevoked(listener: RevokedListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Called after a device is added, revoked or expired (the desktop's list and indicator re-read). */
  onChanged(listener: () => void): () => void {
    this.changeListeners.add(listener)
    return () => this.changeListeners.delete(listener)
  }

  private changed(): void {
    for (const listener of this.changeListeners) {
      try {
        listener()
      } catch {
        // A listener's failure must not undo the change it hears about.
      }
    }
  }

  /** Every live device, newest first. Expired ones are dropped on the way. */
  list(): WebDevice[] {
    this.expire()
    return [...this.file.data.devices].sort((a, b) => b.createdAt - a.createdAt).map(publicOf)
  }

  /**
   * A new device; returns it with its cookie value and its origin key (the only time either secret
   * exists in clear), or undefined when the store is full. Notifies the desktop and logs the sign-in.
   */
  add(rawName: unknown, mode: DeviceSignIn): { device: WebDevice; cookie: string; key: string } | undefined {
    this.expire()
    if (this.file.data.devices.length >= MAX_DEVICES) return undefined
    const now = this.now()
    const record: DeviceRecord = {
      id: randomBytes(12).toString('base64url'),
      name: deviceName(rawName),
      createdAt: now,
      lastSeenAt: now,
      secretHash: '',
      keyHash: '',
      mode
    }
    const secret = randomSecret()
    const key = randomSecret()
    record.secretHash = hashSecret(secret)
    record.keyHash = hashSecret(key)
    this.file.data.devices.push(record)
    this.commit()
    this.accessLog.write({ event: 'sign-in', device: record.id, name: record.name, detail: mode })
    this.notify(`A new device signed in to web access: ${record.name}`, record.id)
    this.changed()
    return { device: publicOf(record), cookie: `${record.id}.${secret}`, key }
  }

  /**
   * The device a cookie value names when one of `keys` is its origin key, or undefined (unknown,
   * wrong secret, no or a wrong key, expired). Constant time in both secrets: the cookie's is always
   * compared, and every offered key (at most MAX_OFFERED_KEYS, at least one compare) is compared
   * against the record's key or a dummy, so the time taken says neither which ids exist nor which
   * part was wrong. Marks the device as seen only when both match: a cookie alone (leaked to another
   * port) must not keep a device from expiring.
   */
  check(cookie: string | undefined, keys: readonly string[] = []): WebDevice | undefined {
    if (cookie === undefined) return undefined
    const parts = cookieParts(cookie)
    if (!parts) return undefined
    const record = this.file.data.devices.find((d) => d.id === parts.id)
    // Hash and compare even for an unknown id, so the time taken does not say which ids exist.
    const secretOk = matchesHash(parts.secret, record?.secretHash ?? DUMMY_HASH) && record !== undefined
    let keyOk = false
    const offered = keys.slice(0, MAX_OFFERED_KEYS)
    for (const key of offered.length > 0 ? offered : ['']) {
      // No early exit: every offered key costs the same compare.
      const match = matchesHash(key, record?.keyHash ?? DUMMY_HASH)
      if (match && key !== '') keyOk = true
    }
    if (!secretOk || !keyOk || !record) return undefined
    const now = this.now()
    if (now - record.lastSeenAt > DEVICE_IDLE_MS && !this.open.has(record.id)) {
      this.drop([record.id], 'expired')
      return undefined
    }
    this.seen(record, now)
    return publicOf(record)
  }

  /** The gateway handed a socket to this device: it is in use for as long as the socket is open. */
  socketOpened(id: string): void {
    this.open.set(id, (this.open.get(id) ?? 0) + 1)
  }

  /** One of the device's sockets closed: it was in use until now. */
  socketClosed(id: string): void {
    const left = (this.open.get(id) ?? 0) - 1
    if (left > 0) this.open.set(id, left)
    else this.open.delete(id)
    // A revoked device is gone already; its sockets closing find no record.
    const record = this.file.data.devices.find((d) => d.id === id)
    if (record) this.seen(record, this.now(), true)
  }

  /** Revokes one device; false when there is none with that id. `by`: the browser that did it (the log). */
  revoke(id: string, reason = 'revoked on the desktop', by?: AccessActor): boolean {
    return this.drop(
      this.file.data.devices.filter((d) => d.id === id).map((d) => d.id),
      'revoke',
      reason,
      by
    ) > 0
  }

  /** Revokes every device; the count revoked. `by`: the browser that did it (the log). */
  revokeAll(reason = 'revoke all', by?: AccessActor): number {
    return this.drop(
      this.file.data.devices.map((d) => d.id),
      'revoke',
      reason,
      by
    )
  }

  /** Revokes every device that signed in with `mode` (regenerating the access link: `link`). */
  revokeSignedInWith(mode: DeviceSignIn, reason: string): number {
    return this.drop(
      this.file.data.devices.filter((d) => d.mode === mode).map((d) => d.id),
      'revoke',
      reason
    )
  }

  accessToken(): AccessTokenRecord | undefined {
    const t = this.file.data.accessToken
    return t ? { ...t } : undefined
  }

  /** Replaces (or, undefined, removes) the access token's record; on disk before it returns. */
  setAccessToken(record: AccessTokenRecord | undefined): void {
    if (record) this.file.data.accessToken = { ...record }
    else delete this.file.data.accessToken
    this.commit()
  }

  password(): PasswordRecord | undefined {
    const p = this.file.data.password
    return p ? { ...p } : undefined
  }

  /** Replaces (or, undefined, removes) the password's record; on disk before it returns. */
  setPassword(record: PasswordRecord | undefined): void {
    if (record) this.file.data.password = { ...record }
    else delete this.file.data.password
    this.commit()
  }

  /** Writes any pending change (quit). Connected devices count as seen now: their sockets close after this. */
  flush(): void {
    const now = this.now()
    for (const d of this.file.data.devices) if (this.open.has(d.id)) this.seen(d, now, true)
    this.file.flush()
  }

  private expire(): void {
    const now = this.now()
    const gone: string[] = []
    for (const d of this.file.data.devices) {
      // A live socket is use, however long since the last request.
      if (this.open.has(d.id)) this.seen(d, now)
      else if (now - d.lastSeenAt > DEVICE_IDLE_MS) gone.push(d.id)
    }
    if (gone.length > 0) this.drop(gone, 'expired')
  }

  /** Marks a device used at `now`; at most once a minute unless `always` (a close, quit). */
  private seen(record: DeviceRecord, now: number, always = false): void {
    if (!always && now - record.lastSeenAt < TOUCH_INTERVAL_MS) return
    if (record.lastSeenAt === now) return
    record.lastSeenAt = now
    // Debounced: a lost `lastSeenAt` only makes a device look a minute older.
    this.file.save()
  }

  private drop(ids: readonly string[], event: 'revoke' | 'expired', reason?: string, by?: AccessActor): number {
    if (ids.length === 0) return 0
    const set = new Set(ids)
    const gone = this.file.data.devices.filter((d) => set.has(d.id))
    this.file.data.devices = this.file.data.devices.filter((d) => !set.has(d.id))
    // Credentials: on disk now, not after the debounce, so a crash cannot bring a revoked device back.
    this.commit()
    for (const d of gone) {
      this.accessLog.write({ event, device: d.id, name: d.name, ...(reason ? { detail: reason } : {}), ...(by ? { by } : {}) })
    }
    for (const listener of this.listeners) {
      try {
        listener(gone.map((d) => d.id))
      } catch {
        // A listener's failure must not keep the others from closing their sockets.
      }
    }
    this.changed()
    return gone.length
  }

  private commit(): void {
    this.file.save()
    this.file.flush()
  }
}
