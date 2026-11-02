import { useEffect, useState } from 'react'
import type { UpdateState } from '../../shared/ipc'
import { ipcErrorMessage } from '../ipc-error'
import { newestUpdateState, openReleaseFailureText, updateNoticeModel } from './update-notice-model'

const platform = navigator.platform.toLowerCase().includes('mac') ? 'mac' : 'other'

/**
 * The dismissible "a new version exists" bar (main/updates). Notice only: the user upgrades by
 * hand. The link asks main to open the release page it built (`updates.openRelease`, no
 * argument); the renderer never sees or passes a URL. `inert` while Settings, an overlay or the
 * close dialog is up, as for the strip and zones: its buttons must not take Tab or Enter behind a modal.
 */
export function UpdateNotice(props: { inert?: boolean }): React.JSX.Element | null {
  const [state, setState] = useState<UpdateState | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const merge = newestUpdateState()
    // StrictMode remounts the effect: the first run's reply must not land after its cleanup, when its
    // merger no longer sees events and a stale reply could overwrite newer state.
    let cancelled = false
    const off = window.cockpit.on('updates.changed', (s) => setState(merge.fromEvent(s)))
    window.cockpit.invoke('updates.state').then((s) => { if (cancelled) return; const r = merge.fromReply(s); if (r) setState(r) }, () => undefined)
    return () => { cancelled = true; off() }
  }, [])
  const model = updateNoticeModel(state, platform)
  if (!model) return null
  return (
    <div className="update-notice" inert={props.inert} role="status" aria-label="Update available">
      <span className="update-notice-text">
        <strong>{model.heading}</strong> {model.action}
        {model.command !== null && <> <code>{model.command}</code></>}
        {' '}
        <button type="button" className="update-notice-link" onClick={() => {
          setError(null)
          window.cockpit.invoke('updates.openRelease').catch((err: unknown) => setError(openReleaseFailureText(ipcErrorMessage(err))))
        }}>
          {model.linkLabel}
        </button>
        <span className="update-notice-note"> {model.note}</span>
        {error !== null && <> <span role="alert">{error}</span></>}
      </span>
      <button type="button" className="update-notice-dismiss" onClick={() => void window.cockpit.invoke('updates.dismiss', { version: model.version })}>
        Dismiss
      </button>
    </div>
  )
}
