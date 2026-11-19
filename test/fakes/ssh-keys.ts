// Test key pairs from ssh2's generator, minus the keys ssh2 itself cannot read back.
//
// ssh2 1.17's `utils.generateKeyPairSync('ed25519')` writes the public key as an SSH bignum: when its
// first byte is 0 (about one key in 256) the zero is dropped and the key comes out 31 bytes long, which
// ssh2's own `parseKey` (and `new Server({ hostKeys })`) refuse as "Malformed OpenSSH private key".
// ssh-link.test.ts makes four such keys at load, so about one CI run in fifty failed on it, on both
// systems (CI runs 44433522886 and 44511224039, the 0.22.0 and 0.23.0 releases). Reproduce:
// 5000 keys gave 23 bad ones. The app never generates keys; only tests do, so this lives here.
import { utils, type ParsedKey } from 'ssh2'

type KeyType = 'ed25519' | 'ecdsa' | 'rsa'
/** ssh2's generator options (its typings split them over overloads by key type). */
interface KeyOptions {
  bits?: number
  comment?: string
  passphrase?: string
  cipher?: string
  rounds?: number
}

/** At 1/256 a bad key, 20 tries in a row failing is never seen; past it something else is wrong. */
const MAX_TRIES = 20

/**
 * `utils.generateKeyPairSync(type, options)`, retried until ssh2 parses the private key back (with the
 * passphrase when there is one) and the public line parses too. Every ssh2 key a test makes goes
 * through this.
 */
export function sshKeyPair(type: KeyType, options?: KeyOptions): { private: string; public: string } {
  for (let i = 0; i < MAX_TRIES; i++) {
    // The cast picks one overload: ssh2 checks the options per type at run time.
    const pair = utils.generateKeyPairSync(type as 'ed25519', (options ?? {}) as Parameters<typeof utils.generateKeyPairSync>[1])
    const priv = utils.parseKey(pair.private, options?.passphrase) as ParsedKey | Error
    const pub = utils.parseKey(pair.public) as ParsedKey | Error
    if (!(priv instanceof Error) && !(pub instanceof Error)) return pair
  }
  throw new Error(`sshKeyPair: ssh2 made ${MAX_TRIES} ${type} keys in a row it cannot parse`)
}
