import { useEffect, useId, useState } from 'react'
import type { WebAccessMode } from '../../shared/types'
import type { WebAccessPatch, WebAccessView, WebDeviceView } from '../../shared/web-access'
import { qrOf } from './qr'
import { Empty, Group, Row, Select, Switch } from './ui'
import { useAction, type Action } from './use-action'
import { useLoaded } from './use-loaded'
import {
  deviceDetail,
  displayedLink,
  draftOf,
  expiresIn,
  hide,
  hiddenReveal,
  isDirty,
  modeHelp,
  modeOptions,
  patchOf,
  qrText,
  revealFrom,
  REVEAL_MS,
  type LinkReveal,
  type WebAccessDraft
} from './web-access-model'

const loadWebAccess = (): Promise<WebAccessView> => window.cockpit.invoke('settings.webAccess')

/**
 * Settings › General › Web access (design-web.md §4): open the cockpit in a browser on another device.
 * Everything here is the desktop's alone (every channel is `no`-class: a browser must never widen its
 * own access), and main validates every value again; the page only shows main's reasons.
 *
 * The access link is a secret. It is not fetched until the person presses Show, it is not in the page
 * while hidden (web-access-model.ts `displayedLink`), and it hides again after a minute, so a
 * screenshot or a screen share of this page leaks nothing by default (§4.2).
 */
export function WebAccessSection(): React.JSX.Element {
  const view = useLoaded(loadWebAccess)
  const { busy, error, run } = useAction()
  const reload = view.reload
  // Another window, a device signing in or out, a socket opening: the list and the state follow.
  useEffect(() => window.cockpit.on('webAccess.changed', () => reload()), [reload])
  // The "last used" phrases move on their own.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(timer)
  }, [])

  return (
    <>
      <Group
        title="Web access"
        description="Open this cockpit in a browser on another device: the same project, tabs and panels, live on both screens. Claude keeps running on this computer. Off by default."
      >
        {view.error && <p role="alert" className="settings-alert">{view.error}</p>}
        {error && <p role="alert" className="settings-alert">{error}</p>}
        {view.data && <WebAccessCard data={view.data} busy={busy} run={run} reload={reload} />}
      </Group>
      {view.data && <Devices devices={view.data.devices} busy={busy} run={run} reload={reload} now={now} />}
    </>
  )
}

function WebAccessCard(props: {
  data: WebAccessView
  busy: string | null
  run: Action['run']
  reload: () => void
}): React.JSX.Element {
  const { data, busy, run, reload } = props
  const id = useId()
  const { form, gateway } = data
  const listening = gateway.state === 'listening'
  const save = (value: WebAccessPatch): void => {
    void run('web-access', () => window.cockpit.invoke('settings.webAccessSet', { value })).then(reload)
  }
  return (
    <>
      {data.risks.length > 0 && (
        <div role="alert" className="settings-alert" data-testid="web-access-risks">
          {data.risks.map((r) => (
            <p key={r}>{r}</p>
          ))}
        </div>
      )}
      <div className="settings-card">
        <Row
          label={
            <>
              Allow browsers to connect
              <GatewayBadge data={data} />
            </>
          }
          htmlFor={`${id}-enabled`}
          help={
            <>
              Listens on {data.bind}, so only this computer can reach it directly; to use it from a phone or
              another computer, put a proxy that publishes it (Tailscale Serve, an SSH tunnel) in front and enter
              its address below.
              {(gateway.state === 'refused' || gateway.state === 'failed') && (
                <span className="warn"> Not listening: {gateway.reason}.</span>
              )}
            </>
          }
        >
          <Switch
            id={`${id}-enabled`}
            checked={form.enabled}
            disabled={busy !== null}
            onChange={(e) => save({ enabled: e.target.checked })}
          />
        </Row>
        <AddressForm data={data} busy={busy} onSave={save} />
        <Row label="Sign-in" htmlFor={`${id}-mode`} help={modeHelp(form.mode)}>
          <Select
            id={`${id}-mode`}
            aria-label="Sign-in"
            value={form.mode}
            disabled={busy !== null}
            onChange={(e) => save({ mode: e.target.value as WebAccessMode })}
          >
            {modeOptions().map((o) => (
              <option key={o.value} value={o.value} disabled={o.unavailable !== undefined}>
                {o.unavailable !== undefined ? `${o.label} (${o.unavailable})` : o.label}
              </option>
            ))}
          </Select>
        </Row>
        {form.mode === 'link' && <LinkRows key={listening ? 'listening' : 'off'} listening={listening} busy={busy} run={run} reload={reload} />}
        {form.mode === 'none' && (
          <Row
            label="No sign-in"
            help="Anyone who can reach the address controls this computer. Host and Origin checks still apply. Use it only behind a proxy that signs people in."
          />
        )}
      </div>
    </>
  )
}

function GatewayBadge(props: { data: WebAccessView }): React.JSX.Element | null {
  const { gateway } = props.data
  if (gateway.state === 'listening') return <span className="settings-badge accent">listening on port {gateway.port}</span>
  if (gateway.state === 'refused' || gateway.state === 'failed') return <span className="settings-badge warn">not listening</span>
  return null
}

/** Port, external origin and extra hosts: a draft that Save sends (main validates and says what to fix). */
function AddressForm(props: {
  data: WebAccessView
  busy: string | null
  onSave: (patch: WebAccessPatch) => void
}): React.JSX.Element {
  const { form } = props.data
  const id = useId()
  const [draft, setDraft] = useState<WebAccessDraft>(() => draftOf(form))
  // Follow main's copy when it changes (another window, a refused save): adjusted while rendering.
  // Only the address fields: a toggle or the sign-in select changes the rest of `form` and must not drop an unsaved edit.
  const savedKey = JSON.stringify([form.port, form.externalOrigin, form.hosts])
  const [seen, setSeen] = useState(savedKey)
  if (seen !== savedKey) {
    setSeen(savedKey)
    setDraft(draftOf(form))
  }
  const [problem, setProblem] = useState<string | null>(null)
  const dirty = isDirty(form, draft)
  const submit = (): void => {
    const result = patchOf(form, draft)
    if ('error' in result) {
      setProblem(result.error)
      return
    }
    setProblem(null)
    props.onSave(result.patch)
  }
  return (
    <>
      <Row label="Port" htmlFor={`${id}-port`} help="The port on this computer. 1024 to 65535.">
        <input
          id={`${id}-port`}
          type="text"
          inputMode="numeric"
          value={draft.port}
          disabled={props.busy !== null}
          onChange={(e) => setDraft({ ...draft, port: e.target.value })}
        />
      </Row>
      <Row
        label="External address"
        htmlFor={`${id}-origin`}
        help="Where browsers reach this through a proxy, such as https://box.tailnet.ts.net. Empty: only this computer's own address. Plain http is refused for any name but this computer."
      >
        <input
          id={`${id}-origin`}
          type="text"
          value={draft.externalOrigin}
          placeholder="https://"
          spellCheck={false}
          disabled={props.busy !== null}
          onChange={(e) => setDraft({ ...draft, externalOrigin: e.target.value })}
        />
      </Row>
      <Row
        label="Allowed host names"
        htmlFor={`${id}-hosts`}
        help="Other names a browser may use in the address bar, one per line. A request with any other name is refused (it blocks DNS rebinding)."
      >
        <textarea
          id={`${id}-hosts`}
          rows={3}
          value={draft.hosts}
          spellCheck={false}
          disabled={props.busy !== null}
          onChange={(e) => setDraft({ ...draft, hosts: e.target.value })}
        />
      </Row>
      {(dirty || problem !== null) && (
        <Row className="settings-form-foot" label={problem !== null ? <span className="settings-error">{problem}</span> : ''}>
          <button
            type="button"
            className="quiet"
            disabled={props.busy !== null}
            onClick={() => {
              setProblem(null)
              setDraft(draftOf(form))
            }}
          >
            Revert
          </button>
          <button type="button" className="primary" disabled={props.busy !== null || !dirty} onClick={submit}>
            Save
          </button>
        </Row>
      )}
    </>
  )
}

/** The access link behind Show, its QR code, Regenerate, and the one-time "add a device" code. */
// Keyed by whether the gateway listens: switching it off remounts this, so nothing that was fetched stays on screen.
function LinkRows(props: { listening: boolean; busy: string | null; run: Action['run']; reload: () => void }): React.JSX.Element {
  const [access, setAccess] = useState<LinkReveal>(hiddenReveal)
  const [once, setOnce] = useState<LinkReveal>(hiddenReveal)
  const [confirmRegenerate, setConfirmRegenerate] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  // A shown link hides itself; a one-time link's countdown ticks.
  useEffect(() => {
    if (!access.shown) return
    const timer = setTimeout(() => setAccess((r) => hide(r)), REVEAL_MS)
    return () => clearTimeout(timer)
  }, [access])
  useEffect(() => {
    if (!once.shown) return
    const timer = setInterval(() => {
      const t = Date.now()
      setNow(t)
      // An expired one-time link leaves renderer state at once, as the access link does after REVEAL_MS.
      setOnce((r) => (r.expiresAt !== undefined && t >= r.expiresAt ? hide(r) : r))
    }, 1000)
    return () => clearInterval(timer)
  }, [once])
  const show = (): void => {
    void props.run('web-link', () => window.cockpit.invoke('settings.webAccessLink')).then((reply) => {
      if (reply) setAccess(revealFrom(reply))
    })
  }
  const regenerate = (): void => {
    setConfirmRegenerate(false)
    void props.run('web-link', () => window.cockpit.invoke('settings.webAccessRegenerate')).then((reply) => {
      // Hidden: the new link appears only on a Show press, as the section promises.
      if (reply) setAccess(hiddenReveal())
      props.reload()
    })
  }
  const addDevice = (): void => {
    void props.run('web-once', () => window.cockpit.invoke('settings.webAccessAddDevice')).then((reply) => {
      if (reply) {
        setNow(Date.now())
        setOnce(revealFrom(reply))
      }
    })
  }
  const disabled = props.busy !== null || !props.listening
  return (
    <>
      <Row
        data-testid="web-access-link"
        label="Access link"
        help={
          access.reason !== undefined
            ? access.reason
            : 'Opens the cockpit on a device once; the browser is then remembered. Anyone who has it can sign in, so it stays hidden until you press Show.'
        }
      >
        {access.shown ? (
          <button type="button" disabled={props.busy !== null} onClick={() => setAccess(hide(access))}>Hide</button>
        ) : (
          <button type="button" disabled={disabled} onClick={show}>Show</button>
        )}
        {confirmRegenerate ? (
          <>
            <span className="settings-confirm">Sign out every device that used it?</span>
            <button type="button" className="danger" disabled={props.busy !== null} onClick={regenerate}>Regenerate</button>
            <button type="button" className="quiet" onClick={() => setConfirmRegenerate(false)}>Cancel</button>
          </>
        ) : (
          <button type="button" className="quiet" disabled={disabled} onClick={() => setConfirmRegenerate(true)}>Regenerate…</button>
        )}
      </Row>
      {access.shown && <LinkDisplay reveal={access} now={now} label="Access link" />}
      <Row
        label="Add a device"
        help="A one-time link and QR code, valid for 10 minutes and for one device: safer to show on a screen than the access link."
      >
        <button type="button" disabled={disabled} onClick={addDevice}>{once.shown ? 'New code' : 'Show code'}</button>
        {once.shown && <button type="button" className="quiet" onClick={() => setOnce(hide(once))}>Hide</button>}
      </Row>
      {once.shown && <LinkDisplay reveal={once} now={now} label="One-time link" />}
    </>
  )
}

function LinkDisplay(props: { reveal: LinkReveal; now: number; label: string }): React.JSX.Element {
  const text = displayedLink(props.reveal, props.now)
  const qr = qrOf(qrText(props.reveal, props.now) ?? '')
  const left = expiresIn(props.reveal, props.now)
  const expired = props.reveal.expiresAt !== undefined && left === ''
  return (
    <div className="settings-item web-access-link">
      {qr && (
        <svg
          className="web-access-qr"
          role="img"
          aria-label={`${props.label} as a QR code`}
          viewBox={`-2 -2 ${qr.size + 4} ${qr.size + 4}`}
          shapeRendering="crispEdges"
        >
          <rect x={-2} y={-2} width={qr.size + 4} height={qr.size + 4} fill="#fff" />
          <path d={qr.path} fill="#000" />
        </svg>
      )}
      <div className="settings-item-main">
        <code className="web-access-link-text" aria-label={props.label}>{expired ? 'This code has expired.' : text}</code>
        {left !== '' && <span className="settings-item-meta">Valid for another {left}, one device.</span>}
      </div>
    </div>
  )
}

function Devices(props: {
  devices: WebDeviceView[]
  busy: string | null
  run: Action['run']
  reload: () => void
  now: number
}): React.JSX.Element {
  const { devices, busy, run, reload, now } = props
  const [confirmAll, setConfirmAll] = useState(false)
  const act = (label: string, fn: () => Promise<unknown>): void => {
    void run(label, fn).then(reload)
  }
  return (
    <Group
      title="Web access devices"
      actions={
        confirmAll ? (
          <>
            <span className="settings-confirm">Sign out all {devices.length}?</span>
            <button
              type="button"
              className="danger"
              disabled={busy !== null}
              onClick={() => {
                setConfirmAll(false)
                act('web-revoke-all', () => window.cockpit.invoke('settings.webDevicesRevokeAll'))
              }}
            >
              Revoke all
            </button>
            <button type="button" className="quiet" onClick={() => setConfirmAll(false)}>Cancel</button>
          </>
        ) : (
          <button type="button" className="quiet danger" disabled={busy !== null || devices.length === 0} onClick={() => setConfirmAll(true)}>
            Revoke all
          </button>
        )
      }
    >
      <div className="settings-card" data-testid="web-access-devices">
        {devices.length === 0 ? (
          <Empty>No device has signed in.</Empty>
        ) : (
          <ul className="settings-list">
            {devices.map((d) => (
              <li key={d.id} className="settings-item" data-testid="web-access-device">
                <div className="settings-item-main">
                  <span className="settings-item-title">
                    {d.name}
                    {d.connected && <span className="settings-badge accent">connected</span>}
                  </span>
                  <span className="settings-item-meta">{deviceDetail(d, now)}</span>
                </div>
                <div className="settings-item-actions">
                  <button
                    type="button"
                    className="quiet"
                    disabled={busy !== null || !d.connected}
                    title="Close its connections; it stays signed in and the page reconnects"
                    onClick={() => act('web-disconnect', () => window.cockpit.invoke('settings.webDeviceDisconnect', { id: d.id }))}
                  >
                    Disconnect
                  </button>
                  <button
                    type="button"
                    className="danger"
                    disabled={busy !== null}
                    title="Sign it out for good"
                    onClick={() => act('web-revoke', () => window.cockpit.invoke('settings.webDeviceRevoke', { id: d.id }))}
                  >
                    Revoke
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Group>
  )
}
