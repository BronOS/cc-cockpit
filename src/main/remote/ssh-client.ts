// The `ssh2` adapter (design-remote-desktop.md §5.1, §8 "The library"): the only file under src/ that
// imports `ssh2` (test/unit/no-direct-ssh2.test.ts), so the library's surface in main stays this
// narrow, typed interface and the connection logic above it (ssh-link.ts) is plain code that unit
// tests drive against `ssh2`'s own `Server` in-process. Only `Client` and `utils.parseKey` are used.
//
// Rules this file keeps for every connection:
//  - No `debug` callback, ever: `ssh2`'s debug lines carry auth details.
//  - Host key algorithms are `ssh2`'s defaults minus `ssh-rsa` (an RSA signature over SHA-1); an RSA
//    host key still works through `rsa-sha2-512` / `rsa-sha2-256`. The caller may put the key types
//    it already knows for the host first (§5.3: otherwise the server could pick a type nothing
//    vouches for, and the known key would never be compared). Ciphers, MACs and key exchanges stay
//    `ssh2`'s defaults, which already leave out CBC and the SHA-1 exchanges; under Electron's
//    BoringSSL there is no `chacha20-poly1305` (`ssh2` drops what `crypto.getCiphers()` lacks), so
//    AES-GCM / CTR is negotiated: scripts/ssh2-electron-check.mjs proves that handshake in Electron.
//  - Sign-in is the caller's `authHandler`, asked once per step with the methods the server still
//    allows, so the order (§5.1) and "each method at most once" are the caller's; secrets travel only
//    inside the method objects it returns and never leave this file in an error.
//  - The dial settles once: `ready` resolves it; anything else ends the client and rejects with the
//    error that ended it, its `ssh2` `level` kept (`client-authentication`, `client-timeout`,
//    `client-socket`, `handshake`, ...), since the caller maps each level to one plain line.
//  - The build bundles `ssh2` into main with its native parts stubbed out (electron.vite.config.ts),
//    so it always runs its pure-JS path, in dev and packaged alike.
import type { Duplex } from 'node:stream'
import { Client, utils, type AnyAuthMethod, type AuthenticationType, type ClientChannel, type ParsedKey, type Prompt } from 'ssh2'

/**
 * The `level` of an error this file makes itself, next to the ones `ssh2` sets: `auth-handler` is a
 * throw from the caller's own handler, `client-config` an option `ssh2` refused before dialling.
 */
export type SshOwnLevel = 'exec-output-limit' | 'exec-timeout' | 'exec-failed' | 'forward-failed' | 'auth-handler' | 'client-config'
/** The levels this file may give an error: its own, and `ssh2`'s two it reuses for the same causes. */
type MadeLevel = SshOwnLevel | 'client-authentication' | 'client-socket'

/** An error from a dial or a connection: `ssh2`'s own `level` when it set one. */
export interface SshError extends Error {
  level: string
  /** Set when the caller's host verifier said no (`ssh2` reports that as a `handshake` error). */
  hostKeyRefused?: boolean
  /** The agent's own failure (no socket, refused), kept beside a later sign-in error for its message. */
  agentError?: string
}

/** A private key `parseKey` accepted; opaque outside this file, handed back in a `publickey` method. */
export interface SshPrivateKey {
  /** The key type (`ssh-ed25519`, `ecdsa-sha2-nistp256`, `ssh-rsa`, ...). */
  readonly type: string
  readonly comment: string
}

export type ParseKeyResult =
  | { kind: 'ok'; key: SshPrivateKey }
  /** Encrypted and no passphrase was given: ask for one. */
  | { kind: 'needs-passphrase' }
  /** Encrypted and the passphrase given does not open it: ask again. */
  | { kind: 'wrong-passphrase' }
  /** Not a private key `ssh2` can read (a public key, FIDO `sk-*` and certificate keys, garbage). */
  | { kind: 'unsupported'; detail: string }

/**
 * One keyboard-interactive round as the server sent it. A round with no prompts (PAM's usual
 * follow-up after the password) is answered by `ssh2` itself with `[]` and never reaches `onRound`.
 */
export interface SshPromptRound {
  name: string
  instructions: string
  prompts: { prompt: string; echo: boolean }[]
}

/** The caller's answer to a round: the responses, or `{ fail }` to end the dial with that text. */
export type SshPromptAnswer = string[] | { fail: string }

/** A sign-in step. The username is the dial's; `ssh2` validates each before sending it. */
export type SshAuthMethod =
  | { type: 'none' }
  | { type: 'password'; password: string }
  | { type: 'publickey'; key: SshPrivateKey }
  /** The agent's socket path (`IdentityAgent`, else the login env's `SSH_AUTH_SOCK`). */
  | { type: 'agent'; agent: string }
  | { type: 'keyboard-interactive'; onRound: (round: SshPromptRound) => SshPromptAnswer | Promise<SshPromptAnswer> }

/**
 * The next sign-in step. `methodsLeft` is null on the first call (nothing is known yet: return
 * `none` to learn what the server offers) and then the methods the server still accepts;
 * `false` gives up, and the dial rejects with `client-authentication`.
 */
export type SshAuthHandler = (
  methodsLeft: string[] | null,
  partialSuccess: boolean
) => SshAuthMethod | false | Promise<SshAuthMethod | false>

/**
 * Decides the server's host key: the raw key blob as sent (`string type, ...`), from which the
 * caller computes the fingerprint and type. Sync or async; a throw or a rejection refuses.
 */
export type SshHostVerifier = (key: Buffer) => boolean | Promise<boolean>

export interface DialOptions {
  host: string
  port: number
  username: string
  authHandler: SshAuthHandler
  hostVerifier: SshHostVerifier
  /**
   * Key types (as in known_hosts: `ssh-ed25519`, `ecdsa-sha2-nistp256`, `ssh-rsa`, ...) to put
   * first in the host key algorithms offered. `ssh-rsa` stands for `rsa-sha2-512` and
   * `rsa-sha2-256` (an RSA key's known_hosts type is `ssh-rsa` whatever it signs with); unknown
   * types are ignored.
   */
  preferredHostKeyTypes?: readonly string[]
  /** Handshake plus sign-in, in ms (§5.1: 10 s, 30 s when the agent is tried). */
  readyTimeout: number
}

export interface ExecResult {
  stdout: string
  stderr: string
  /** The exit code, or null when the command ended on a signal or sent no status. */
  code: number | null
}

export interface ExecOptions {
  /** stdout plus stderr, in bytes; more fails with `exec-output-limit` and closes the channel. */
  maxBytes: number
  /** From the request to the channel's close; later fails with `exec-timeout` and closes it. */
  timeoutMs: number
}

/** A connection that completed sign-in. */
export interface SshConnection {
  /** Runs `command` (one string the server's shell parses: the caller quotes it) and collects its output. */
  exec(command: string, options: ExecOptions): Promise<ExecResult>
  /** A `direct-tcpip` channel to 127.0.0.1:`dstPort` on the server, `srcPort` the local socket's port. */
  forwardOut(srcPort: number, dstPort: number): Promise<Duplex>
  /** Ends the connection (a no-op once closed). `onClose` listeners fire when the socket closes. */
  end(): void
  /** Called once when the connection closes, with the error that closed it when there was one. */
  onClose(listener: (error?: SshError) => void): () => void
}

/** Keepalive: 15 s × 3 unanswered (§5.1), so a dropped network ends the connection in about 45 s. */
const KEEPALIVE_INTERVAL_MS = 15_000
const KEEPALIVE_COUNT_MAX = 3
/** After `end()`, the socket is destroyed if the server has not closed its side by then. */
const END_GRACE_MS = 2000

/** `ssh2`'s default host key algorithms minus `ssh-rsa`, in its order (ed25519 only when crypto signs it). */
const HOST_KEY_ALGORITHMS = [
  'ssh-ed25519',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'rsa-sha2-512',
  'rsa-sha2-256'
] as const
type HostKeyAlgorithm = (typeof HOST_KEY_ALGORITHMS)[number]

/** The `algorithms.serverHostKey` operations: drop `ssh-rsa` and the preferred ones, then put those first. */
export function hostKeyAlgorithmOps(preferred: readonly string[] = []): { remove: string[]; prepend: string[] } {
  const first: HostKeyAlgorithm[] = []
  for (const type of preferred) {
    const algos: readonly string[] = type === 'ssh-rsa' ? ['rsa-sha2-512', 'rsa-sha2-256'] : [type]
    for (const a of algos) {
      const known = HOST_KEY_ALGORITHMS.find((k) => k === a)
      if (known && !first.includes(known)) first.push(known)
    }
  }
  // `ssh2`'s `prepend` skips a name already in the list, so the preferred ones are removed first
  // (object key order is the order `ssh2` applies the operations in).
  return { remove: ['ssh-rsa', ...first], prepend: first }
}

function sshError(message: string, level: MadeLevel): SshError {
  const e = new Error(message) as SshError
  e.level = level
  return e
}

/** An `ssh2` error with its level, or a generic one for an error that has none. */
function asSshError(err: unknown, fallbackLevel: MadeLevel): SshError {
  if (err instanceof Error) {
    const e = err as SshError
    if (typeof e.level !== 'string') e.level = fallbackLevel
    return e
  }
  return sshError(String(err), fallbackLevel)
}

/** The parsed keys handed out by `parseKey`, so a `publickey` method gets back the real `ParsedKey`. */
const parsedKeys = new WeakMap<SshPrivateKey, ParsedKey>()

/**
 * Parses a private key file's bytes (§5.1: main reads and parses the file before dialling, since
 * `ssh2` silently skips a key it cannot parse). A key that is encrypted is told apart from a wrong
 * passphrase by parsing again without one: only `ssh2`'s "no passphrase given" text marks an
 * encrypted key (OpenSSH, old PEM and PPK formats all say it).
 */
export function parseKey(data: Buffer | string, passphrase?: string): ParseKeyResult {
  const parse = (pass?: string): ParsedKey | Error => {
    try {
      const r = utils.parseKey(data, pass === undefined || pass === '' ? undefined : pass) as ParsedKey | ParsedKey[] | Error
      if (Array.isArray(r)) return r[0] ?? new Error('no key in the file')
      return r
    } catch (err) {
      return err instanceof Error ? err : new Error(String(err))
    }
  }
  const needsPassphrase = (e: Error): boolean => e.message.includes('no passphrase given')
  const result = parse(passphrase)
  if (result instanceof Error) {
    if (needsPassphrase(result)) return { kind: 'needs-passphrase' }
    if (passphrase) {
      const bare = parse(undefined)
      if (bare instanceof Error && needsPassphrase(bare)) return { kind: 'wrong-passphrase' }
    }
    return { kind: 'unsupported', detail: result.message }
  }
  if (!result.isPrivateKey()) return { kind: 'unsupported', detail: 'a public key, not a private key' }
  const key: SshPrivateKey = Object.freeze({ type: result.type, comment: result.comment })
  parsedKeys.set(key, result)
  return { kind: 'ok', key }
}

/**
 * Opens a connection and signs in. Resolves on `ready`; rejects once with the error that ended the
 * attempt (the caller's verifier refusing, every sign-in method failing, the timeout, the socket).
 */
export function dial(options: DialOptions): Promise<SshConnection> {
  const client = new Client()
  return new Promise<SshConnection>((resolve, reject) => {
    let settled = false
    let ready = false
    let hostKeyRefused = false
    let agentError: string | undefined
    // The first error that is not the agent's: `ssh2` reports a failed agent and goes on to the next
    // method, so that one is only kept for the message.
    let failure: SshError | undefined
    const life: Life = { closed: false, error: undefined, listeners: new Set() }

    const fail = (error: SshError): void => {
      if (settled) return
      settled = true
      if (hostKeyRefused) error.hostKeyRefused = true
      if (agentError !== undefined) error.agentError = agentError
      reject(error)
      client.destroy()
    }
    // An error from inside our own callbacks (the caller's handler threw): end the attempt with it.
    const abort = (error: SshError): void => {
      if (!failure) failure = error
      client.destroy()
    }

    client.on('error', (err: Error) => {
      const e = asSshError(err, 'client-socket')
      if (!ready) {
        if (e.level === 'agent') {
          agentError = e.message
          return
        }
        if (!failure) failure = e
        return
      }
      // After sign-in (a keepalive timeout, the socket): kept for the close listeners.
      if (!life.error) life.error = e
    })
    client.on('close', () => {
      life.closed = true
      if (!ready) {
        fail(failure ?? sshError('the connection closed before sign-in finished', 'client-socket'))
        return
      }
      for (const listener of [...life.listeners]) {
        try {
          listener(life.error)
        } catch {
          // A listener's own failure must not keep the others from hearing about the close.
        }
      }
      life.listeners.clear()
    })
    client.on('ready', () => {
      ready = true
      settled = true
      resolve(connection(client, life))
    })

    const authHandler = (methodsLeft: AuthenticationType[] | null, partialSuccess: boolean | null, next: (m: AnyAuthMethod | false) => void): void => {
      // One chain, one catch: a throw from the caller's handler and one from `ssh2` sending the step
      // both end the attempt instead of becoming an unhandled rejection with the dial still waiting.
      Promise.resolve()
        .then(() => options.authHandler(methodsLeft ? [...methodsLeft] : null, partialSuccess === true))
        .then((method) => next(method === false ? false : toSsh2Method(method, options.username, abort)))
        .catch((err: unknown) => abort(asSshError(err, 'auth-handler')))
    }

    const hostVerifier = (key: Buffer, verify: (permitted: boolean) => void): undefined => {
      const decide = (ok: boolean): void => {
        if (!ok) hostKeyRefused = true
        verify(ok)
      }
      Promise.resolve()
        .then(() => options.hostVerifier(Buffer.from(key)))
        .then(
          (ok) => decide(ok === true),
          () => decide(false)
        )
        .catch((err: unknown) => abort(asSshError(err, 'client-socket')))
      return undefined
    }

    try {
      client.connect({
        host: options.host,
        port: options.port,
        username: options.username,
        readyTimeout: options.readyTimeout,
        keepaliveInterval: KEEPALIVE_INTERVAL_MS,
        keepaliveCountMax: KEEPALIVE_COUNT_MAX,
        // The types allow only the documented forms; `ssh2` validates every name it gets.
        algorithms: { serverHostKey: hostKeyAlgorithmOps(options.preferredHostKeyTypes) as never },
        // Arity 2: `ssh2` waits for `verify` (our answer may come later, from an async verifier).
        hostVerifier: hostVerifier as never,
        authHandler: authHandler as never
      })
    } catch (err) {
      // A config `ssh2` refuses synchronously (a bad username type): no socket was opened.
      settled = true
      reject(asSshError(err, 'client-config'))
    }
  })
}

/** The caller's method as `ssh2` takes it; a keyboard-interactive round goes through `onRound`. */
function toSsh2Method(method: SshAuthMethod, username: string, abort: (e: SshError) => void): AnyAuthMethod | false {
  switch (method.type) {
    case 'none':
      return { type: 'none', username }
    case 'password':
      return { type: 'password', username, password: method.password }
    case 'publickey': {
      const key = parsedKeys.get(method.key)
      // A key object `parseKey` did not make: nothing to sign with, so the step fails like a refused key.
      if (!key) return false
      return { type: 'publickey', username, key }
    }
    case 'agent':
      return { type: 'agent', username, agent: method.agent }
    case 'keyboard-interactive':
      return {
        type: 'keyboard-interactive',
        username,
        prompt: (name: string, instructions: string, _lang: string, prompts: Prompt[], finish: (responses: string[]) => void) => {
          const round: SshPromptRound = {
            name,
            instructions,
            prompts: prompts.map((p) => ({ prompt: p.prompt, echo: p.echo === true }))
          }
          Promise.resolve()
            .then(() => method.onRound(round))
            .then((answer) => {
              if (Array.isArray(answer)) finish(answer)
              else abort(sshError(answer.fail, 'client-authentication'))
            })
            .catch((err: unknown) => abort(asSshError(err, 'auth-handler')))
        }
      }
  }
}

/** A connection's close state, shared by the dial's listeners and the `SshConnection`. */
interface Life {
  closed: boolean
  /** The error that closed it (a keepalive timeout, the socket), when one did. */
  error: SshError | undefined
  listeners: Set<(error?: SshError) => void>
}

function connection(client: Client, life: Life): SshConnection {
  return {
    exec(command, { maxBytes, timeoutMs }) {
      return new Promise<ExecResult>((resolve, reject) => {
        let done = false
        let channel: ClientChannel | undefined
        const finish = (error: SshError | undefined, result?: ExecResult): void => {
          if (done) return
          done = true
          clearTimeout(timer)
          if (error) {
            // Closing the channel stops the command's output; the server may keep the process.
            channel?.close()
            reject(error)
          } else resolve(result as ExecResult)
        }
        const timer = setTimeout(() => finish(sshError(`the command took longer than ${timeoutMs} ms`, 'exec-timeout')), timeoutMs)
        try {
          client.exec(command, (err, ch) => {
            if (err) return finish(asSshError(err, 'exec-failed'))
            channel = ch
            if (done) {
              ch.close()
              return
            }
            const out: Buffer[] = []
            const errOut: Buffer[] = []
            let bytes = 0
            let code: number | null = null
            const take = (into: Buffer[]) => (chunk: Buffer) => {
              if (done) return
              bytes += chunk.length
              if (bytes > maxBytes) return finish(sshError(`the command printed more than ${maxBytes} bytes`, 'exec-output-limit'))
              into.push(chunk)
            }
            ch.on('data', take(out))
            ch.stderr.on('data', take(errOut))
            ch.on('exit', (exitCode: number | null) => {
              code = typeof exitCode === 'number' ? exitCode : null
            })
            ch.on('close', () =>
              finish(undefined, { stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(errOut).toString('utf8'), code })
            )
          })
        } catch (err) {
          // `ssh2` throws "Not connected" synchronously once the socket is gone.
          finish(asSshError(err, 'client-socket'))
        }
      })
    },
    forwardOut(srcPort, dstPort) {
      return new Promise<Duplex>((resolve, reject) => {
        try {
          client.forwardOut('127.0.0.1', srcPort, '127.0.0.1', dstPort, (err, ch) => {
            if (err) reject(asSshError(err, 'forward-failed'))
            else resolve(ch)
          })
        } catch (err) {
          reject(asSshError(err, 'client-socket'))
        }
      })
    },
    end() {
      if (life.closed) return
      client.end()
      // A server that never closes its side would keep the socket (and the close listeners) waiting.
      setTimeout(() => {
        if (!life.closed) client.destroy()
      }, END_GRACE_MS).unref()
    },
    onClose(listener) {
      if (life.closed) {
        const error = life.error
        queueMicrotask(() => listener(error))
        return () => {}
      }
      life.listeners.add(listener)
      return () => {
        life.listeners.delete(listener)
      }
    }
  }
}
