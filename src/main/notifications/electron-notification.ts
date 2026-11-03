// The real NoticeBackend: Electron's `Notification`. The only file that imports it (CLAUDE.md:
// Electron-only modules behind adapters); notifier.ts has the logic and the unit tests.
//
// Per platform (Electron 45):
//   - `actions` (the button) shows on macOS and Windows; Linux's libnotify path offers only the
//     click on the notification itself (the daemon's default action), which is the same answer.
//   - `timeoutType: 'never'` (Linux, Windows) keeps a notification with an action on screen until it
//     is clicked or dismissed: with the default the pop-up expires after a few seconds, the OS
//     reports that as `close`, and a reminder looked at a moment later could no longer be answered.
//     notifier.ts closes it after NOTIFY_ACTION_WAIT_MS anyway. macOS ignores it (banner or alert
//     is the person's choice in System Settings).
//   - `silent: true` drops the OS sound (Linux sends the `suppress-sound` hint, which daemons may
//     ignore); absent leaves the platform's default, as before.
//   - `failed` (macOS, Windows) means it never showed: treated as closed.
import { Notification } from 'electron'
import type { NativeNotice, NoticeBackend, NoticeSpec } from './notifier'

export class ElectronNoticeBackend implements NoticeBackend {
  isSupported(): boolean {
    return Notification.isSupported()
  }

  create(spec: NoticeSpec): NativeNotice {
    const n = new Notification({
      title: spec.title,
      body: spec.body,
      ...(spec.silent !== undefined ? { silent: spec.silent } : {}),
      ...(spec.actionLabel !== undefined ? { actions: [{ type: 'button' as const, text: spec.actionLabel }] } : {}),
      ...(spec.persistent ? { timeoutType: 'never' as const } : {})
    })
    return {
      show: () => n.show(),
      close: () => n.close(),
      onClick: (listener) => {
        n.on('click', listener)
        n.on('action', listener)
      },
      onClose: (listener) => {
        n.on('close', listener)
        n.on('failed', listener)
      }
    }
  }
}
