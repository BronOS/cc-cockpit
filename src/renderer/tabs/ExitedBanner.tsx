import type { TabInfo } from '../../shared/ipc'

type Exit = NonNullable<TabInfo['exit']>

/** "exited (code 1)", or "exited (signal 9)" when a signal ended the process. */
export function exitLabel(exit: Exit): string {
  return exit.signal ? `exited (signal ${exit.signal})` : `exited (code ${exit.code})`
}

/**
 * Shown over a tab whose process ended: "exited (code N): Restart · Close". A restored command tab
 * that never ran (`notStarted`) says so instead: restore does not run commands by itself.
 */
export function ExitedBanner(props: {
  exit: Exit
  notStarted?: boolean
  onRestart: () => void
  onClose: () => void
}): React.JSX.Element {
  return (
    <div className="exited-banner" role="status">
      <span>{props.notStarted ? 'not started (restored commands run only when you ask)' : exitLabel(props.exit)}: </span>
      <button type="button" onClick={props.onRestart}>
        Restart
      </button>
      {' · '}
      <button type="button" onClick={props.onClose}>
        Close
      </button>
    </div>
  )
}
