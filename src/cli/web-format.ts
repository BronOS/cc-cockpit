// What `ccc web` prints (design-web.md §9.4). The reply comes from whatever owns the socket, so every
// field is checked for its type and text goes through the caller's `plain` (control characters out)
// before it reaches a terminal: a device name is the browser's own text.
import type { WebCliStatus, WebCredentialState, WebDeviceView, WebGatewayView } from '../shared/web-access'

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

function gatewayLine(gateway: WebGatewayView | undefined, plain: Plain): string {
  switch (gateway?.state) {
    case 'listening':
      return `listening on ${plain(gateway.bind)}:${plain(String(gateway.port))}, links point at ${plain(gateway.origin)}`
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

/** `ccc web status` without `--json`: one fact per line, the devices last. */
export function formatWebStatus(result: unknown, plain: Plain): string {
  const s = (result ?? {}) as Partial<WebCliStatus>
  const secrets = (s.secrets ?? {}) as Partial<WebCliStatus['secrets']>
  const lines = [
    `server mode: ${s.server === true ? 'yes' : 'no (the desktop app)'}`,
    `web access: ${s.enabled === true ? 'on' : 'off'}`,
    `sign-in: ${MODE_NAMES[String(s.mode)] ?? plain(s.mode)}`,
    `address: ${plain(s.bind)}:${plain(String(s.port))}`,
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
  lines.push(`access link: ${credential(s.accessLink, 'made', 'not made yet', 'regenerate it')}`)
  lines.push(`password: ${credential(s.password, 'set', 'not set', 'set it again')}`)
  const devices = Array.isArray(s.devices) ? (s.devices as Array<Partial<WebDeviceView>>) : []
  lines.push(devices.length === 0 ? 'devices: none signed in' : `devices: ${devices.length}`)
  for (const d of devices) lines.push(deviceLine(d, plain))
  return `${lines.join('\n')}\n`
}
