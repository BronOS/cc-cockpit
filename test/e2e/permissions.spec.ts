// Browser permissions are denied by default (main/windows/permissions.ts). Electron grants every
// permission to a session without a handler, so the discriminating check is the shell page itself:
// it lives in the default session and is the one page main grants anything to ('local-fonts').
// The html overlay's iframe is `sandbox="allow-scripts"`, yet Blink's permissions policy does not
// refuse everything there by itself: with Electron's grant-all answer, permissions.query read some
// of these as granted in it. Url overlays: overlays.spec.ts.
import { expect, test, type Cockpit } from './fixtures'

/** What the page answers for each permission, as navigator.permissions.query reads it (the check handler). */
const QUERY = `Promise.all(['geolocation', 'notifications', 'clipboard-read', 'midi', 'local-fonts'].map((name) =>
  navigator.permissions.query({ name }).then((s) => [name, s.state], (e) => [name, 'error: ' + e.name])
)).then(Object.fromEntries)`

test('the shell page reads every permission as denied but local-fonts, and a request is refused', async ({ cockpit }) => {
  const states = await cockpit.page.evaluate(QUERY)
  expect(states).toEqual({
    geolocation: 'denied',
    notifications: 'denied',
    'clipboard-read': 'denied',
    midi: 'denied',
    'local-fonts': 'granted'
  })
  // The request handler: before the lock-down Electron answered 'granted' here.
  expect(await cockpit.page.evaluate('Notification.requestPermission()')).toBe('denied')
})

async function htmlOverlayValue(c: Cockpit, script: string): Promise<unknown> {
  const html = `<!doctype html><script>
    window.addEventListener('message', (e) => {
      const port = e.ports[0]
      if (!port) return
      // A synchronous throw (a sandboxed frame may refuse at once) is answered like a rejection.
      new Promise((resolve) => resolve(${script})).then(
        (value) => port.postMessage({ type: 'result', value }),
        (err) => port.postMessage({ type: 'result', value: 'error: ' + err.name })
      )
    })
  </script>`
  const handle = await c.hook<number | undefined>('openOverlay', c.projectDir, { kind: 'html', html })
  if (handle === undefined) throw new Error('no window for the project')
  let result: { kind: string; value?: unknown } | undefined
  await expect
    .poll(async () => {
      result = (await c.hook<{ result?: { kind: string; value?: unknown } } | undefined>('overlayResult', handle))?.result
      return result !== undefined
    })
    .toBe(true)
  expect(result?.kind).toBe('value')
  return result?.value
}

test('an html overlay is denied geolocation, notifications and clipboard reads', async ({ cockpit }) => {
  const states = (await htmlOverlayValue(cockpit, QUERY)) as Record<string, string>
  for (const name of ['geolocation', 'notifications', 'clipboard-read', 'midi', 'local-fonts']) {
    expect(states[name], name).not.toBe('granted')
  }
  expect(await htmlOverlayValue(cockpit, 'Notification.requestPermission()')).toBe('denied')
  expect(await htmlOverlayValue(cockpit, 'navigator.clipboard.readText()')).toMatch(/^error: /)
})
