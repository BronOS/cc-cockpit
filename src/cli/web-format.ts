// What `ccc web` prints (design-web.md §9.4). The reply comes from whatever owns the socket, so every
// field is checked for its type and text goes through the caller's `plain` (control characters out)
// before it reaches a terminal: a device name is the browser's own text.
import { MIN_NETWORK_PASSWORD_LENGTH, type WebCliNotice, type WebCliStatus, type WebCredentialState, type WebDeviceView, type WebGatewayView } from '../shared/web-access'

type Plain = (text: unknown) => string

const STORE_NAMES: Record<string, string> = {
  os: 'the OS keychain',
  keyfile: "server mode's key file (secret.key in the data dir)",
  fake: 'the test store (not encrypted)'
}

const MODE_NAMES: Record<string, string> = {
  link: 'access link',
  password: 'password',
  confirm: 'desktop confirm',
  none: 'none (no sign-in)'
}

/** A credential's state; `fix` says what to do about one that cannot be read. */
function credential(state: unknown, set: string, unset: string, fix: string): string {
  switch (state as WebCredentialState) {
    case 'set':
      return set
    case 'unset':
      return unset
    case 'other-mode':
      return `stored by the other mode's secret store: ${fix}`
    case 'replaced':
      return `made under a replaced key file: ${fix}`
    default:
      return 'unknown'
  }
}

/** host:port with an IPv6 address bracketed, so `::` and port 7000 do not read `:::7000`. */
function hostPort(bind: unknown, port: unknown, plain: Plain): string {
  const host = plain(bind)
  return `${host.includes(':') ? `[${host}]` : host}:${plain(String(port))}`
}

function gatewayLine(gateway: WebGatewayView | undefined, plain: Plain): string {
  switch (gateway?.state) {
    case 'listening':
      return `listening on ${hostPort(gateway.bind, gateway.port, plain)}, links point at ${plain(gateway.origin)}`
    case 'refused':
    case 'failed':
      return `not listening: ${plain(gateway.reason)}`
    case 'off':
      return 'off'
    default:
      return 'unknown'
  }
}

function time(ms: unknown): string {
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : 'unknown'
}

function deviceLine(d: Partial<WebDeviceView>, plain: Plain): string {
  const connected = d.connected === true ? '\tconnected' : ''
  return `  ${plain(d.id)}\t${plain(d.name)}\tsigned in with ${plain(d.mode)}\tlast seen ${time(d.lastSeenAt)}${connected}`
}

const NOTICE_KINDS: Record<string, string> = {
  'new-device': 'new device',
  revoked: 'plugin revoked',
  update: 'update',
  'sign-in-failures': 'failed sign-ins',
  'access-changed': 'access changed'
}

/** A core notice: when, what it is, its line; a new device also says whose sign-in `web-access.log` has. */
function noticeLine(n: Partial<WebCliNotice>, plain: Plain): string {
  const device = typeof n.device === 'string' && n.device !== '' ? `\tdevice ${plain(n.device)} (sign-in in web-access.log)` : ''
  return `  ${time(n.at)}\t${NOTICE_KINDS[String(n.kind)] ?? plain(n.kind)}\t${plain(n.text)}${device}`
}

/** `ccc web status` without `--json`: one fact per line, the devices last. */
export function formatWebStatus(result: unknown, plain: Plain): string {
  const s = (result ?? {}) as Partial<WebCliStatus>
  const secrets = (s.secrets ?? {}) as Partial<WebCliStatus['secrets']>
  const lines = [
    `version: ${typeof s.version === 'string' ? plain(s.version) : 'unknown'}`,
    `server mode: ${s.server === true ? 'yes' : 'no (the desktop app)'}`,
    `web access: ${s.enabled === true ? 'on' : 'off'}`,
    `sign-in: ${MODE_NAMES[String(s.mode)] ?? plain(s.mode)}`,
    `address: ${hostPort(s.bind, s.port, plain)}`,
    `external origin: ${typeof s.externalOrigin === 'string' ? plain(s.externalOrigin) : 'none'}`,
    `gateway: ${gatewayLine(s.gateway, plain)}`,
    `secret store: ${STORE_NAMES[String(secrets.store)] ?? plain(secrets.store)}`
  ]
  if (typeof secrets.unavailable === 'string') lines.push(`  unavailable: ${plain(secrets.unavailable)}`)
  if (typeof secrets.otherMode === 'number' && secrets.otherMode > 0) {
    lines.push(`  ${secrets.otherMode} stored value(s) belong to the other mode's store and cannot be read here: enter them again`)
  }
  if (typeof secrets.replaced === 'number' && secrets.replaced > 0) {
    lines.push(`  ${secrets.replaced} stored value(s) were made under a replaced key file: enter them again`)
  }
  // Server mode's browser picker only: on the desktop the native folder dialog is used.
  if (s.server === true) {
    lines.push(`start folder: ${typeof s.startFolder === 'string' ? plain(s.startFolder) : 'the home folder (default)'}`)
  }
  lines.push(`access link: ${credential(s.accessLink, 'made', 'not made yet', 'regenerate it')}`)
  lines.push(`password: ${credential(s.password, 'set', 'not set', 'set it again')}`)
  if (s.passwordShort === true) lines.push(`  the password is shorter than ${MIN_NETWORK_PASSWORD_LENGTH} characters, too short for an address others reach: change it (ccc web password)`)
  const devices = Array.isArray(s.devices) ? (s.devices as Array<Partial<WebDeviceView>>) : []
  lines.push(devices.length === 0 ? 'devices: none signed in' : `devices: ${devices.length}`)
  for (const d of devices) lines.push(deviceLine(d, plain))
  // Server mode's core notices (stdout lines of this run); the desktop has none to list.
  const notices = Array.isArray(s.notices) ? (s.notices as Array<Partial<WebCliNotice>>) : []
  if (notices.length > 0) {
    lines.push(`notices: ${notices.length}`)
    for (const n of notices) lines.push(noticeLine(n, plain))
  }
  return `${lines.join('\n')}\n`
}

/**
 * `ccc web set` after a change was saved: the address and whether the gateway listens there now (a
 * port in use or an unreadable certificate is saved all the same and shows here as the reason), and
 * the browser picker's start folder when one is set.
 */
export function formatWebSaved(result: unknown, plain: Plain): string {
  const s = (result ?? {}) as Partial<WebCliStatus>
  const start = typeof s.startFolder === 'string' ? `start folder: ${plain(s.startFolder)}\n` : ''
  return `saved\naddress: ${hostPort(s.bind, s.port, plain)}\ngateway: ${gatewayLine(s.gateway, plain)}\n${start}`
}
