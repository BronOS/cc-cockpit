import { useState } from 'react'
import type { ClaudeCodeView } from '../../shared/ipc'
import { isServerView, isWebShell } from '../shell-kind'
import { claudeOfferText } from '../tabs/claude-offer-model'
import { CommandLine, InstallInTabButton } from '../tabs/ClaudeInstallControls'

/**
 * Settings › General › Claude Code, under the start-up switch: what the start-up dialog offered, for after
 * it was declined (it is asked once per launch). 'missing': main's install command with Copy, and Install
 * in a new tab where main allows it (`installInTab`; the desktop page, or a server's browser: a browser of
 * a desktop is refused by main, so the button is not drawn there). 'off-path': the PATH line. Nothing when
 * `claude` is found.
 */
export function ClaudeInstallRow(props: { view: ClaudeCodeView; onChanged: () => void }): React.JSX.Element | null {
  const { view } = props
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null)
  if (view.state === 'found') return null
  const pathLine = claudeOfferText(view).pathLine
  const canInstall = view.state === 'missing' && view.installInTab && (!isWebShell() || isServerView())
  return (
    <div className="settings-row claude-install-row" data-testid="claude-install">
      <div className="settings-row-text claude-offer">
        {view.state === 'missing' && <CommandLine text={view.command} label="the install command" testId="claude-settings-command" />}
        {pathLine !== undefined && <CommandLine text={pathLine} label="the PATH line" testId="claude-settings-path" />}
        {note !== null && (
          <p role={note.error ? 'alert' : 'status'} className={note.error ? 'settings-alert' : undefined}>
            {note.text}
          </p>
        )}
      </div>
      {canInstall && (
        <InstallInTabButton
          onOpened={() => {
            setNote({ text: 'The installer is running in a new tab.', error: false })
            props.onChanged()
          }}
          onError={(text) => setNote({ text, error: true })}
        />
      )}
    </div>
  )
}
