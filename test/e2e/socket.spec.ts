import { existsSync, statSync } from 'node:fs'
import { connect } from 'node:net'
import { expect, launchCockpit, test } from './fixtures'

test('main listens on a 0600 CLI socket, answers on it and removes it on quit', async () => {
  const { cockpit, close } = await launchCockpit()
  let path = ''
  try {
    const info = await cockpit.hook<{ path: string; listening: boolean }>('socket')
    path = info.path
    expect(info.listening).toBe(true)
    expect(statSync(path).isSocket()).toBe(true)
    expect(statSync(path).mode & 0o777).toBe(0o600)

    // A tokenless call to a token-only command is refused by the server itself (no handlers yet).
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = connect(path)
      let buf = ''
      socket.on('error', reject)
      socket.on('data', (d) => {
        buf += d.toString()
        if (buf.includes('\n')) {
          socket.destroy()
          resolve(buf.trim())
        }
      })
      socket.write('{"v":1,"id":9,"cmd":"hook","project":"/x","args":{}}\n')
    })
    expect(JSON.parse(reply)).toMatchObject({ id: 9, ok: false, error: expect.stringMatching(/needs a tab token/) })
  } finally {
    await close()
  }
  // The e2e data dir is long, so the socket usually sits in the fallback dir outside the temp
  // root that close() deletes: its absence shows main unlinked it on quit.
  expect(existsSync(path)).toBe(false)
})
