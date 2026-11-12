// The `ccc web` answers over a built-in SSH link (src/main/remote/remote-status.ts): the exec is a fake
// that records the command and answers with fixed output, so only the parsing and messages are tested.
import { describe, expect, it } from 'vitest'
import { REMOTE_CCC_MISSING, remoteCommand } from '../../src/shared/remote-servers'
import {
  addDeviceToken,
  answerLine,
  runCcc,
  serverStatus,
  shownText,
  type RemoteExec,
  type RemoteExecResult
} from '../../src/main/remote/remote-status'

/** An exec answering every command with `result`, recording the commands. */
function answering(stdout: string, code: number | null = 0, stderr = ''): { exec: RemoteExec; commands: string[] } {
  const commands: string[] = []
  const exec: RemoteExec = async (command) => {
    commands.push(command)
    return { stdout, stderr, code } satisfies RemoteExecResult
  }
  return { exec, commands }
}

describe('runCcc', () => {
  it('runs the one quoted remote command, the override as the script argument', async () => {
    const { exec, commands } = answering('ok\n')
    await expect(runCcc(exec, 'devbox', ['web', 'status', '--json'])).resolves.toBe('ok')
    expect(commands).toEqual([remoteCommand(['web', 'status', '--json'])])
    await runCcc(exec, 'devbox', ['web', 'add-device'], '/opt/ccc')
    expect(commands[1]?.endsWith("'sh' '/opt/ccc' 'web' 'add-device'")).toBe(true)
  })

  it('refuses an override that cannot be quoted before running anything', async () => {
    const { exec, commands } = answering('ok\n')
    await expect(runCcc(exec, 'devbox', ['web'], "/a'b")).rejects.toThrow('single quote')
    expect(commands).toHaveLength(0)
  })

  it('returns the last non-empty stdout line, rc-file noise before it ignored', async () => {
    const { exec } = answering('Welcome to devbox\r\nlast login: today\n{"a":1}\r\n\n  \n')
    await expect(runCcc(exec, 'devbox', ['web'])).resolves.toBe('{"a":1}')
  })

  it('calls empty stdout a missing install or a stopped server', async () => {
    await expect(runCcc(answering('\n \n').exec, 'devbox', ['web'])).rejects.toThrow(
      'cc-cockpit is not installed on devbox, or the server is not running.'
    )
  })

  it('names a missing ccc from the script marker (exit 127)', async () => {
    await expect(runCcc(answering(`motd\n${REMOTE_CCC_MISSING}\n`, 127).exec, 'devbox', ['web'])).rejects.toThrow(
      "cc-cockpit's ccc was not found on devbox"
    )
  })

  it('a failed command shows its last stderr line, stripped and capped; else the exit code or the signal', async () => {
    await expect(runCcc(answering('', 1, 'warning\nccc: something \u001b[31mbroke\u0007 here\n').exec, 'devbox', ['web'])).rejects.toThrow(
      /^ccc on devbox failed: ccc: something \[31mbroke here$/
    )
    const long = await runCcc(answering('', 1, `${'z'.repeat(1000)}\n`).exec, 'devbox', ['web']).catch((e: Error) => e)
    expect((long as Error).message.length).toBeLessThan(340)
    await expect(runCcc(answering('', 3).exec, 'devbox', ['web'])).rejects.toThrow('ccc on devbox failed (exit code 3).')
    await expect(runCcc(answering('', null).exec, 'devbox', ['web'])).rejects.toThrow('ccc on devbox was stopped before it answered.')
  })

  it('a transport failure keeps its words', async () => {
    const exec: RemoteExec = () => Promise.reject(new Error('the command took longer than 20000 ms'))
    await expect(runCcc(exec, 'devbox', ['web'])).rejects.toThrow('running ccc on devbox failed: the command took longer than 20000 ms')
  })

  it('answerLine and shownText are the plain helpers', () => {
    expect(answerLine('h', { stdout: 'a\nb\n', stderr: '', code: 0 })).toBe('b')
    expect(shownText('a\n\tb  c', 300)).toBe('a b c')
    expect(shownText('x'.repeat(20), 10)).toBe(`${'x'.repeat(9)}…`)
  })
})

describe('serverStatus and addDeviceToken', () => {
  const status = (over: Record<string, unknown> = {}): string =>
    JSON.stringify({
      server: true,
      version: '0.17.0',
      scheme: 'http',
      enabled: true,
      mode: 'link',
      port: 7420,
      gateway: { state: 'listening', bind: '127.0.0.1', port: 7421, origin: 'http://127.0.0.1:7421' },
      ...over
    })

  it('returns the listening port, mode and version, asking with web status --json', async () => {
    const { exec, commands } = answering(`noise\n${status()}\n`)
    await expect(serverStatus(exec, 'devbox')).resolves.toEqual({ port: 7421, mode: 'link', version: '0.17.0' })
    expect(commands).toEqual([remoteCommand(['web', 'status', '--json'])])
  })

  it('refuses a desktop app (not server mode)', async () => {
    await expect(serverStatus(answering(status({ server: false })).exec, 'devbox')).rejects.toThrow(
      'devbox is not a cc-cockpit server in server mode'
    )
  })

  it('asks for an update when scheme is absent, naming the version when there is one', async () => {
    await expect(serverStatus(answering(status({ scheme: undefined })).exec, 'devbox')).rejects.toThrow('Update cc-cockpit on devbox (it runs 0.17.0).')
    await expect(serverStatus(answering(status({ scheme: undefined, version: undefined })).exec, 'devbox')).rejects.toThrow(
      'Update cc-cockpit on devbox (it runs an older version).'
    )
    await expect(serverStatus(answering(status({ scheme: 'gopher' })).exec, 'devbox')).rejects.toThrow('Update cc-cockpit')
  })

  it('refuses https over the tunnel with the §5.8 text', async () => {
    await expect(serverStatus(answering(status({ scheme: 'https' })).exec, 'devbox')).rejects.toThrow(
      'Connect Direct with its address, or turn TLS off: the SSH tunnel encrypts already.'
    )
  })

  it('refuses web access off, a gateway not listening and broken fields', async () => {
    await expect(serverStatus(answering(status({ enabled: false, gateway: { state: 'off' } })).exec, 'devbox')).rejects.toThrow('Web access is off')
    await expect(serverStatus(answering(status({ gateway: { state: 'failed', reason: 'port in use\u0007' } })).exec, 'devbox')).rejects.toThrow(
      'The web gateway on devbox is not listening: port in use'
    )
    await expect(serverStatus(answering(status({ gateway: { state: 'listening', port: '7421' } })).exec, 'devbox')).rejects.toThrow(
      'no usable gateway port'
    )
    await expect(serverStatus(answering(status({ mode: 'magic' })).exec, 'devbox')).rejects.toThrow('sign-in mode')
    await expect(serverStatus(answering('not json at all').exec, 'devbox')).rejects.toThrow('not a cc-cockpit status: not json at all')
    await expect(serverStatus(answering('[1,2]').exec, 'devbox')).rejects.toThrow('not a cc-cockpit status')
  })

  it('keeps only the token of the add-device link', async () => {
    const { exec, commands } = answering('motd\nhttps://devbox.example:7421/#t=abc123\n')
    await expect(addDeviceToken(exec, 'devbox')).resolves.toBe('abc123')
    expect(commands).toEqual([remoteCommand(['web', 'add-device'])])
    await expect(addDeviceToken(answering('http://127.0.0.1:7421/\n').exec, 'devbox')).rejects.toThrow('did not answer with an add-device link')
    await expect(addDeviceToken(answering('nonsense\n').exec, 'devbox')).rejects.toThrow('did not answer with an add-device link')
  })
})
