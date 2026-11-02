import { useEffect, useState } from 'react'
import type { UpdateState } from '../../shared/ipc'
import { updateNoticeModel } from './update-notice-model'

const platform = navigator.platform.toLowerCase().includes('mac') ? 'mac' : 'other'

/**
 * The dismissible "a new version exists" bar (main/updates). Notice only: the user upgrades by
 * hand. The link asks main to open the release page it built (`updates.openRelease`, no
 * argument); the renderer never sees or passes a URL.
 */
export function UpdateNotice(): React.JSX.Element | null {
  const [state, setState] = useState<UpdateState | null>(null)
  useEffect(() => {
    const off = window.cockpit.on('updates.changed', setState)
    window.cockpit.invoke('updates.state').then(setState, () => undefined)
    return off
  }, [])
  const model = updateNoticeModel(state, platform)
  if (!model) return null
  return (
    <div className="update-notice" role="status" aria-label="Update available">
      <span className="update-notice-text">
        <strong>{model.heading}</strong> {model.action}
        {model.command !== null && <> <code>{model.command}</code></>}
        {' '}
        <button type="button" className="update-notice-link" onClick={() => void window.cockpit.invoke('updates.openRelease')}>
          {model.linkLabel}
        </button>
        <span className="update-notice-note"> {model.note}</span>
      </span>
      <button type="button" className="update-notice-dismiss" onClick={() => void window.cockpit.invoke('updates.dismiss')}>
        Dismiss
      </button>
    </div>
  )
}
