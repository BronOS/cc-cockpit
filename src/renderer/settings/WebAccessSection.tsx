import { useEffect, useId, useState } from 'react'
import type { WebAccessMode, WebAccessRisk } from '../../shared/types'
import type { WebAccessPatch, WebAccessView, WebDeviceView } from '../../shared/web-access'
import { ApprovalDialog } from '../notices/ApprovalDialog'
import { isServerView } from '../shell-kind'
import { qrOf } from './qr'
import { RiskConfirmDialog } from './RiskConfirmDialog'
import { Empty, Group, Row, Select, Switch } from './ui'
import { useAction, type Action } from './use-action'
import { useLoaded } from './use-loaded'
import {
  confirmedPatch,
  confirmsNeeded,
  desktopCredentialNotes,
  deviceAskText,
  deviceDetail,
  displayedLink,
  draftOf,
  expiresIn,
  hide,
  hiddenReveal,
  isDirty,
  modeHelp,
  modeNeedsPassword,
  modeOptions,
  NONE_MODE_NOTE,
  NONE_REVOKE_NOTE,
  passwordDraftProblem,
  patchOf,
  qrText,
  revealFrom,
  REVEAL_MS,
  SERVER_CARD_FOOT,
  serverCardRows,
  type DeviceAsk,
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
  // A server's browser (design-web.md §9.4): the read-only card, settings changed with `ccc web`.
  return isServerView() ? <ServerWebAccessSection /> : <DesktopWebAccessSection />
}

function DesktopWebAccessSection(): React.JSX.Element {
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
      {view.data && (
        <Devices devices={view.data.devices} noSignIn={view.data.form.mode === 'none'} busy={busy} run={run} reload={reload} now={now} />
      )}
    </>
  )
}

/**
 * The card in a server's browser view (design-web.md §9.4, §9.6): read-only. It shows the mode, the
 * address, the link and password states, the secret store, why desktop confirm is off and None's
 * shared-server warning, and says that `ccc web` on the server changes them; it never shows a link
 * or a QR code (main sends it none: minting is `no`-class in both modes). The devices keep Revoke,
 * Disconnect and Revoke all, each behind the in-page approval: a lost phone is revoked from another
 * device with no SSH at hand, and a click on its way cannot sign a device out.
 */
function ServerWebAccessSection(): React.JSX.Element {
  const view = useLoaded(loadWebAccess)
  const { busy, error, run } = useAction()
  const reload = view.reload
  // A device signing in, a socket opening, a `ccc web mode` on the server: the card follows, live.
  useEffect(() => window.cockpit.on('webAccess.changed', () => reload()), [reload])
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(timer)
  }, [])
  return (
    <>
      <Group
        title="Web access"
        description="This cockpit runs as a server: browsers are the only way in. What is set now, read-only here."
      >
        {view.error && <p role="alert" className="settings-alert">{view.error}</p>}
        {error && <p role="alert" className="settings-alert">{error}</p>}
        {view.data && (
          <div className="settings-card" data-testid="web-access-server-card">
            {serverCardRows(view.data).map((row) => (
              <Row
                key={row.key}
                label={row.label}
                data-testid={`web-access-row-${row.key}`}
                help={row.warn ? <span className="warn">{row.text}</span> : row.text}
              />
            ))}
            <Row label="" help={SERVER_CARD_FOOT} />
          </div>
        )}
      </Group>
      {view.data && (
        <Devices
          devices={view.data.devices}
          noSignIn={view.data.form.mode === 'none'}
          busy={busy}
          run={run}
          reload={reload}
          now={now}
          inPageConfirm
        />
      )}
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
  // Picked the password mode with no password set: main refuses the switch, so the password rows ask
  // for one first and switch after it is saved. Cleared by any other pick.
  const [pendingPassword, setPendingPassword] = useState(false)
  // A change main answered with `needsConfirm` (design-web.md §4.3): nothing is saved until every
  // risk in it is confirmed, then the same change goes again with `confirm`.
  const [ask, setAsk] = useState<{ patch: WebAccessPatch; risks: WebAccessRisk[] } | null>(null)
  const save = (value: WebAccessPatch): void => {
    void run('web-access', () => window.cockpit.invoke('settings.webAccessSet', { value })).then((reply) => {
      const risks = reply && confirmsNeeded(reply)
      if (risks) setAsk({ patch: value, risks })
      reload()
    })
  }
  const pickMode = (mode: WebAccessMode): void => {
    if (modeNeedsPassword(mode, data.passwordSet)) {
      setPendingPassword(true)
      return
    }
    setPendingPassword(false)
    if (mode !== form.mode) save({ mode })
  }
  const shownMode = pendingPassword ? 'password' : form.mode
  return (
    <>
      {ask && (
        <RiskConfirmDialog
          risks={ask.risks}
          onAnswer={(accepted) => {
            setAsk(null)
            if (accepted) save(confirmedPatch(ask.patch, ask.risks))
          }}
        />
      )}
      {desktopCredentialNotes(data.credentials).map((note) => (
        <p key={note} role="alert" className="settings-alert warn">
          {note}
        </p>
      ))}
      {data.passwordShort && (
        <p role="alert" className="settings-alert warn" data-testid="web-access-password-short">
          The password is shorter than {data.passwordMinLength} characters, too short for an address others can reach. It still works; change it
          below.
        </p>
      )}
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
              {data.network ? (
                <>
                  Listens on {form.bind}, so other devices on the network reach it directly
                  {form.certPath !== '' ? ' over https.' : ', over plain http.'}
                </>
              ) : (
                <>
                  Listens on {form.bind}, so only this computer can reach it directly; to use it from a phone or
                  another computer, put a proxy that publishes it (Tailscale Serve, an SSH tunnel) in front and
                  enter its address below, or listen on the network.
                </>
              )}
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
        <Row label="Sign-in" htmlFor={`${id}-mode`} help={modeHelp(shownMode)}>
          <Select
            id={`${id}-mode`}
            aria-label="Sign-in"
            value={shownMode}
            disabled={busy !== null}
            onChange={(e) => pickMode(e.target.value as WebAccessMode)}
          >
            {modeOptions().map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </Row>
        {form.mode === 'link' && !pendingPassword && (
          <LinkRows key={listening ? 'listening' : 'off'} listening={listening} busy={busy} run={run} reload={reload} />
        )}
        {shownMode === 'password' && (
          <PasswordRows
            passwordSet={data.passwordSet}
            minLength={data.passwordMinLength}
            busy={busy}
            run={run}
            onSaved={() => {
              // The switch the person asked for, now that main will take it.
              if (pendingPassword) {
                setPendingPassword(false)
                save({ mode: 'password' })
              } else reload()
            }}
            onCancel={pendingPassword ? () => setPendingPassword(false) : undefined}
          />
        )}
        {form.mode === 'none' && !pendingPassword && (
          <Row label="No sign-in" help={NONE_MODE_NOTE} />
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
  const savedKey = JSON.stringify([form.bind, form.port, form.externalOrigin, form.hosts, form.certPath, form.keyPath])
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
      <Row
        label="Listen on"
        htmlFor={`${id}-bind`}
        help="127.0.0.1: this computer only (a proxy can publish it). 0.0.0.0: every network this computer is on, so a phone on the same Wi-Fi can open it; or one of this computer's addresses for that network only. On a network, without a certificate or with no sign-in, you are asked to confirm first."
      >
        <input
          id={`${id}-bind`}
          type="text"
          value={draft.bind}
          spellCheck={false}
          disabled={props.busy !== null}
          onChange={(e) => setDraft({ ...draft, bind: e.target.value })}
        />
      </Row>
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
        className="web-access-tls"
        label="Certificate"
        htmlFor={`${id}-cert`}
        help="For https: the full path of a certificate file (PEM, with its chain) and of its key file, such as the ones tailscale cert or mkcert writes. Empty: plain http. Read when web access starts, so a renewed certificate takes effect after turning it off and on."
      >
        <input
          id={`${id}-cert`}
          type="text"
          aria-label="Certificate file"
          value={draft.certPath}
          placeholder="/path/to/cert.pem"
          spellCheck={false}
          disabled={props.busy !== null}
          onChange={(e) => setDraft({ ...draft, certPath: e.target.value })}
        />
        <input
          type="text"
          aria-label="Key file"
          value={draft.keyPath}
          placeholder="/path/to/key.pem"
          spellCheck={false}
          disabled={props.busy !== null}
          onChange={(e) => setDraft({ ...draft, keyPath: e.target.value })}
        />
      </Row>
      <Row
        label="External address"
        htmlFor={`${id}-origin`}
        help="Where browsers reach this through a proxy, or the name the certificate is for, such as https://box.tailnet.ts.net. Empty: this computer's own addresses. Plain http on any name but this computer asks you to confirm first."
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

/**
 * Set or change the password: typed twice, never shown, cleared once saved. Main hashes it (scrypt,
 * off its main thread) and keeps only the keychain's ciphertext of the hash; a change signs out every
 * device that signed in with the old one, which the help says before the person presses Save.
 */
function PasswordRows(props: {
  passwordSet: boolean
  minLength: number
  busy: string | null
  run: Action['run']
  onSaved: () => void
  onCancel: (() => void) | undefined
}): React.JSX.Element {
  const id = useId()
  const [password, setPassword] = useState('')
  const [repeat, setRepeat] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const submit = (): void => {
    const local = passwordDraftProblem(password, repeat, props.minLength)
    if (local !== undefined) {
      setProblem(local)
      return
    }
    setProblem(null)
    void props.run('web-password', () => window.cockpit.invoke('settings.webAccessSetPassword', { password })).then((reply) => {
      if (!reply) return
      if (!reply.ok) {
        setProblem(reply.reason)
        return
      }
      setPassword('')
      setRepeat('')
      props.onSaved()
    })
  }
  return (
    <>
      <Row
        label={props.passwordSet ? 'New password' : 'Password'}
        htmlFor={`${id}-password`}
        help={
          props.passwordSet
            ? 'A password is set. Saving a new one signs out every browser that signed in with the old one.'
            : `Set a password to sign in with (at least ${props.minLength} characters). Browsers ask for it on their sign-in page.`
        }
      >
        <input
          id={`${id}-password`}
          type="password"
          autoComplete="new-password"
          value={password}
          disabled={props.busy !== null}
          onChange={(e) => setPassword(e.target.value)}
        />
      </Row>
      <Row label="Repeat it" htmlFor={`${id}-repeat`}>
        <input
          id={`${id}-repeat`}
          type="password"
          autoComplete="new-password"
          value={repeat}
          disabled={props.busy !== null}
          onChange={(e) => setRepeat(e.target.value)}
        />
      </Row>
      <Row className="settings-form-foot" label={problem !== null ? <span className="settings-error">{problem}</span> : ''}>
        {props.onCancel && (
          <button type="button" className="quiet" disabled={props.busy !== null} onClick={props.onCancel}>
            Cancel
          </button>
        )}
        <button type="button" className="primary" disabled={props.busy !== null || password === ''} onClick={submit}>
          {props.passwordSet ? 'Change password' : 'Set password'}
        </button>
      </Row>
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
  /** None is on: Revoke keeps nobody out, and the list says so. */
  noSignIn: boolean
  busy: string | null
  run: Action['run']
  reload: () => void
  now: number
  /**
   * A server's browser (design-web.md §9.6): Revoke, Disconnect and Revoke all ask first with the
   * in-page approval (ApprovalDialog), which a click or a key already on its way cannot answer.
   */
  inPageConfirm?: boolean
}): React.JSX.Element {
  const { devices, busy, run, reload, now } = props
  const [confirmAll, setConfirmAll] = useState(false)
  const [ask, setAsk] = useState<DeviceAsk | null>(null)
  const act = (label: string, fn: () => Promise<unknown>): void => {
    void run(label, fn).then(reload)
  }
  const perform = (what: DeviceAsk): void => {
    if (what.kind === 'revoke') act('web-revoke', () => window.cockpit.invoke('settings.webDeviceRevoke', { id: what.id }))
    else if (what.kind === 'disconnect') act('web-disconnect', () => window.cockpit.invoke('settings.webDeviceDisconnect', { id: what.id }))
    else act('web-revoke-all', () => window.cockpit.invoke('settings.webDevicesRevokeAll'))
  }
  // At once on the desktop (Revoke all has its own inline confirm there), asked first in a server's browser.
  const request = (what: DeviceAsk): void => {
    if (props.inPageConfirm) setAsk(what)
    else perform(what)
  }
  const askText = ask ? deviceAskText(ask) : undefined
  return (
    <>
      {ask && askText && (
        <ApprovalDialog
          title={askText.title}
          allowLabel={askText.allowLabel}
          denyLabel="Cancel"
          onAnswer={(yes) => {
            setAsk(null)
            if (yes) perform(ask)
          }}
        >
          <p>{askText.body}</p>
        </ApprovalDialog>
      )}
      <Group
        title="Web access devices"
        actions={
          props.inPageConfirm ? (
            <button
              type="button"
              className="quiet danger"
              disabled={busy !== null || devices.length === 0}
              onClick={() => request({ kind: 'revoke-all', count: devices.length })}
            >
              Revoke all
            </button>
          ) : confirmAll ? (
            <>
              <span className="settings-confirm">Sign out all {devices.length}?</span>
              <button
                type="button"
                className="danger"
                disabled={busy !== null}
                onClick={() => {
                  setConfirmAll(false)
                  perform({ kind: 'revoke-all', count: devices.length })
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
          {props.noSignIn && (
            <p className="settings-alert warn inset" data-testid="web-access-none-revoke">
              {NONE_REVOKE_NOTE}
            </p>
          )}
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
                      onClick={() => request({ kind: 'disconnect', id: d.id, name: d.name })}
                    >
                      Disconnect
                    </button>
                    <button
                      type="button"
                      className="danger"
                      disabled={busy !== null}
                      title="Sign it out for good"
                      onClick={() => request({ kind: 'revoke', id: d.id, name: d.name })}
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
    </>
  )
}
