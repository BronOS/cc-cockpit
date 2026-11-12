// known_hosts lookup and fingerprints (src/main/remote/known-hosts.ts). The fixture keys and the
// hashed lines were made once with OpenSSH (`ssh-keygen -t ed25519`, `ssh-keygen -l`, `ssh-keygen -H`)
// and are hard-coded, so the format is checked against ssh's own output, not against this code.
import { createHmac, randomBytes } from 'node:crypto'
import { utils } from 'ssh2'
import { describe, expect, it } from 'vitest'
import { checkKnownHost, fingerprint, keyBlobType, knownHostKeys, knownHostKeyTypes, knownHostName } from '../../src/main/remote/known-hosts'

const ED25519 = 'AAAAC3NzaC1lZDI1NTE5AAAAIGnCThfVfTI+1kHah/aiO67IJnI08AQdHg8Amr4kODi7'
/** `ssh-keygen -l -f fixture.pub` for the ed25519 key above. */
const ED25519_SHA256 = 'SHA256:hXz3IBRrMC/s7qrTu5LHjK5iTCIexLwEM+6+yM3EyTg'
const ECDSA =
  'AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBAi2UE5KEe/yy0K69Ds++c2CgDNM4Kc+YS3cUKsOmW/FSSg8BX5MDCQnAYROgp5exQtjy4PASRaO5txxbXEI/9A='
const ECDSA_SHA256 = 'SHA256:b2F7fqy2IL1iMisBBxpVxOBhKbpg7oAy1FELjDtKMHk'
/** `ssh-keygen -H` of `devbox.lan` and `[devbox.lan]:2222`, both with the ed25519 key. */
const SSH_KEYGEN_HASHED = [
  `|1|TfXXpWt2OgJRYzxeYtrk19NW3wk=|LmDnmlEVvgw5csUjf9WZ2BbWKIk= ssh-ed25519 ${ED25519}`,
  `|1|rE4QAqXDNthibcz8r6sEnIPlUs4=|m7UzOpNqrMskTybWiiydqI1zoUQ= ssh-ed25519 ${ED25519}`
].join('\n')

const ed = Buffer.from(ED25519, 'base64')
const ec = Buffer.from(ECDSA, 'base64')
/** Another ed25519 key: "the server was reinstalled", or a man in the middle. */
const otherEd = Buffer.from(utils.generateKeyPairSync('ed25519').public.split(' ')[1]!, 'base64')

/** A hashed entry made here the way ssh does: HMAC-SHA1 of the host field, keyed by a random 20-byte salt. */
function hashed(name: string): string {
  const salt = randomBytes(20)
  return `|1|${salt.toString('base64')}|${createHmac('sha1', salt).update(name).digest('base64')}`
}

describe('fingerprint', () => {
  it('matches ssh-keygen -l (SHA256, unpadded base64)', () => {
    expect(fingerprint(ed)).toBe(ED25519_SHA256)
    expect(fingerprint(ec)).toBe(ECDSA_SHA256)
  })

  it('keyBlobType reads the type field and refuses junk', () => {
    expect(keyBlobType(ed)).toBe('ssh-ed25519')
    expect(keyBlobType(ec)).toBe('ecdsa-sha2-nistp256')
    expect(keyBlobType(Buffer.alloc(3))).toBeNull()
    expect(keyBlobType(Buffer.from([0, 0, 0, 9, 0x61]))).toBeNull()
    expect(keyBlobType(Buffer.from([0, 0, 0, 1, 0x0a]))).toBeNull()
  })
})

describe('knownHostKeys and checkKnownHost', () => {
  it('a plain entry in a comma list trusts the key, case-insensitively', () => {
    const text = `# comment\n\nother,DevBox.lan,10.0.0.5 ssh-ed25519 ${ED25519} me@laptop\n`
    expect(checkKnownHost('devbox.lan', 22, 'ssh-ed25519', ed, text)).toBe('trusted')
    expect(checkKnownHost('10.0.0.5', 22, 'ssh-ed25519', ed, text)).toBe('trusted')
    expect(checkKnownHost('devbox', 22, 'ssh-ed25519', ed, text)).toBe('unknown')
  })

  it('hashed entries: ssh-keygen -H output and one made in the test', () => {
    expect(checkKnownHost('devbox.lan', 22, 'ssh-ed25519', ed, SSH_KEYGEN_HASHED)).toBe('trusted')
    expect(checkKnownHost('devbox.lan', 2222, 'ssh-ed25519', ed, SSH_KEYGEN_HASHED)).toBe('trusted')
    expect(checkKnownHost('devbox.lan', 2200, 'ssh-ed25519', ed, SSH_KEYGEN_HASHED)).toBe('unknown')
    const text = `${hashed('[build.corp]:2022')} ecdsa-sha2-nistp256 ${ECDSA}\n`
    expect(checkKnownHost('build.corp', 2022, 'ecdsa-sha2-nistp256', ec, text)).toBe('trusted')
    expect(checkKnownHost('build.corp', 22, 'ecdsa-sha2-nistp256', ec, text)).toBe('unknown')
  })

  it('a malformed hashed entry never matches', () => {
    const text = [`|1|nope|nope ssh-ed25519 ${ED25519}`, `|2|${hashed('devbox').slice(3)} ssh-ed25519 ${ED25519}`].join('\n')
    expect(checkKnownHost('devbox', 22, 'ssh-ed25519', ed, text)).toBe('unknown')
  })

  it('the [host]:port form for a port other than 22, and only there', () => {
    expect(knownHostName('DevBox', 22)).toBe('devbox')
    expect(knownHostName('devbox', 2222)).toBe('[devbox]:2222')
    const text = `[devbox]:2222 ssh-ed25519 ${ED25519}\n`
    expect(checkKnownHost('devbox', 2222, 'ssh-ed25519', ed, text)).toBe('trusted')
    expect(checkKnownHost('devbox', 22, 'ssh-ed25519', ed, text)).toBe('unknown')
    // A plain `devbox` line says nothing about port 2222 (ssh looks up `[devbox]:2222` only).
    expect(checkKnownHost('devbox', 2222, 'ssh-ed25519', ed, `devbox ssh-ed25519 ${ED25519}\n`)).toBe('unknown')
  })

  it('a different key of the same type is changed; another type is unknown', () => {
    const text = `devbox ssh-ed25519 ${ED25519}\n`
    expect(checkKnownHost('devbox', 22, 'ssh-ed25519', otherEd, text)).toBe('changed')
    expect(checkKnownHost('devbox', 22, 'ecdsa-sha2-nistp256', ec, text)).toBe('unknown')
    expect(checkKnownHost('devbox', 22, 'ssh-ed25519', otherEd, `${hashed('devbox')} ssh-ed25519 ${ED25519}\n`)).toBe('changed')
  })

  it('a host with two lines of the same type trusts either key', () => {
    const text = `devbox ssh-ed25519 ${ED25519}\ndevbox ssh-ed25519 ${otherEd.toString('base64')}\n`
    expect(checkKnownHost('devbox', 22, 'ssh-ed25519', otherEd, text)).toBe('trusted')
    expect(knownHostKeys('devbox', 22, text).keys.get('ssh-ed25519')).toHaveLength(2)
  })

  it('@revoked matches by key for any host, before a trusting line', () => {
    const text = `devbox ssh-ed25519 ${ED25519}\n@revoked * ssh-ed25519 ${ED25519}\n`
    expect(checkKnownHost('devbox', 22, 'ssh-ed25519', ed, text)).toBe('revoked')
    expect(checkKnownHost('elsewhere', 2222, 'ssh-ed25519', ed, text)).toBe('revoked')
    const known = knownHostKeys('devbox', 22, text)
    expect(known.revoked).toHaveLength(1)
    expect(known.keys.get('ssh-ed25519')).toHaveLength(1)
  })

  it('wildcard and negated patterns and @cert-authority are ignored', () => {
    const text = [
      `*.lan ssh-ed25519 ${ED25519}`,
      `dev?ox ssh-ed25519 ${ED25519}`,
      `devbox,!bad ssh-ed25519 ${otherEd.toString('base64')}`,
      `@cert-authority devbox ssh-ed25519 ${ED25519}`,
      `@future devbox ssh-ed25519 ${ED25519}`
    ].join('\n')
    expect(checkKnownHost('devbox', 22, 'ssh-ed25519', ed, text)).toBe('unknown')
    expect(checkKnownHost('devbox', 22, 'ssh-ed25519', otherEd, text)).toBe('unknown')
    expect(checkKnownHost('devbox.lan', 22, 'ssh-ed25519', ed, text)).toBe('unknown')
    // An exact name beside a wildcard on the same line still matches, as in ssh.
    expect(checkKnownHost('devbox', 22, 'ssh-ed25519', ed, `*.lan,devbox ssh-ed25519 ${ED25519}\n`)).toBe('trusted')
  })

  it('lines whose type and blob disagree, or whose base64 is broken, say nothing', () => {
    const text = [`devbox ssh-rsa ${ED25519}`, `devbox ssh-ed25519 ${ED25519.slice(0, -3)}!!!`, 'devbox ssh-ed25519'].join('\r\n')
    expect(knownHostKeys('devbox', 22, text).keys.size).toBe(0)
  })

  it('knownHostKeyTypes lists the types in file order, for the dial to prefer', () => {
    const rsa = Buffer.from(utils.generateKeyPairSync('rsa', { bits: 2048 }).public.split(' ')[1]!, 'base64')
    const text = [
      `devbox ecdsa-sha2-nistp256 ${ECDSA}`,
      `other ssh-ed25519 ${ED25519}`,
      `devbox ssh-rsa ${rsa.toString('base64')}`,
      `devbox ecdsa-sha2-nistp256 ${ECDSA}`
    ].join('\n')
    expect(knownHostKeyTypes(knownHostKeys('devbox', 22, text))).toEqual(['ecdsa-sha2-nistp256', 'ssh-rsa'])
    expect(checkKnownHost('devbox', 22, 'ssh-rsa', rsa, text)).toBe('trusted')
  })
})
