import { useEffect, useState } from 'react'
import type { WebAccessIndicator } from '../../shared/web-access'
import { indicatorText, indicatorTitle } from '../settings/web-access-model'
import { isWebShell } from '../shell-kind'
import { WebConfirmCard } from './WebConfirmCard'

/**
 * The top bar's web access indicator (design-web.md §4.1 "Visible on the desktop"): how many
 * browsers are connected, and a warning while a risky choice (§4.3) is on. One click opens Settings
 * (General › Web access), where the devices list has Disconnect, Revoke and Revoke all. Nothing is
 * drawn while no device is connected and nothing warns, so with web access off the bar is as it was.
 * Desktop windows only: a browser view cannot ask for it (`no`-class) and would show itself to itself.
 * It also carries the desktop-confirm request card (WebConfirmCard), which rides on the same event.
 */
export function WebAccessChip(props: { onOpen: () => void }): React.JSX.Element | null {
  const [indicator, setIndicator] = useState<WebAccessIndicator | null>(null)
  useEffect(() => {
    if (isWebShell()) return
    let live = true
    window.cockpit.invoke('webAccess.state').then(
      (value) => {
        if (live) setIndicator(value)
      },
      () => undefined
    )
    const off = window.cockpit.on('webAccess.changed', setIndicator)
    return () => {
      live = false
      off()
    }
  }, [])
  if (!indicator) return null
  const text = indicatorText(indicator)
  // A browser waiting for a desktop confirm is shown whether or not any device is connected.
  const confirm = indicator.confirm ? <WebConfirmCard ask={indicator.confirm} /> : null
  if (text === undefined) return confirm
  return (
    <>
      {confirm}
      <button
        type="button"
        className={indicator.warning !== undefined ? 'web-access-chip warn' : 'web-access-chip'}
        title={indicatorTitle(indicator)}
        aria-label={`Web access: ${text}${indicator.warning !== undefined ? ', warning' : ''}`}
        onClick={props.onOpen}
      >
        <span className="web-access-chip-dot" aria-hidden="true" />
        {text}
      </button>
    </>
  )
}
