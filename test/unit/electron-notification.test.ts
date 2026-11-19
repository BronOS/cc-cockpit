// The Electron Notification adapter (electron-notification.ts) with a fake `Notification`: a notice
// the OS refuses (`failed`, e.g. an ad-hoc signed macOS build) leaves a log line whether or not anyone
// listens for its close. Notifier.show (a download refused, a failed save) never calls onClose.
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

const made: FakeNotification[] = []

class FakeNotification extends EventEmitter {
  constructor(readonly options: Record<string, unknown>) {
    super()
    made.push(this)
  }
  show(): void {}
  close(): void {}
  static isSupported(): boolean {
    return true
  }
}

vi.mock('electron', () => ({ Notification: FakeNotification }))

const { ElectronNoticeBackend } = await import('../../src/main/notifications/electron-notification')

afterEach(() => {
  made.length = 0
  vi.restoreAllMocks()
})

describe('ElectronNoticeBackend', () => {
  it('logs a notice the OS refused even with no close listener, with the error only, never the text', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const notice = new ElectronNoticeBackend().create({ title: 'cc-cockpit', body: 'secret subject was not saved' })
    notice.show()
    made[0]?.emit('failed', {}, 'Notifications are not allowed for this application')
    expect(warn.mock.calls.map((c) => String(c[0]))).toEqual(['a notification did not show: Notifications are not allowed for this application'])
  })

  it('a refused notice counts as closed for a close listener, logged once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const notice = new ElectronNoticeBackend().create({ title: 'cc-cockpit', body: 'x' })
    const closed = vi.fn()
    notice.onClose(closed)
    made[0]?.emit('failed', {}, 'denied')
    made[0]?.emit('close', {})
    expect(closed).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
