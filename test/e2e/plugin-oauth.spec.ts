// ctx.oauth end to end (plan "accounts to plugins" Task 5; replaces the Accounts page's OAuth spec):
// the host-oauth fixture plugin's project settings get the fake provider's URLs and client (the
// secret through a secret settings field), its "signin" command calls ctx.oauth.authorize, main
// sends the system browser to the provider (shell.openExternal is replaced in main by a recorder)
// and the test plays the browser against test/fakes/fake-oauth-server.ts: consent, then the
// redirect to main's loopback on 127.0.0.1. The plugin stores the refresh token with ctx.secrets
// and refreshes once with it. A first sign-in is cut off by a host restart: its loopback must close.
//
// The fake provider is https: ctx.oauth refuses any other URL, loopback included. It serves TLS
// with a throwaway self-signed certificate made here by `openssl` (SAN IP:127.0.0.1); only this
// app run trusts it, through NODE_EXTRA_CA_CERTS, which Node in Electron's main reads at startup
// only. Hence this file's own `cockpit` fixture (the shared one launches without that variable).
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test as base } from '@playwright/test'
import type { HostStatus } from '../../src/main/plugins/host-manager'
import { FAKE_PREFIX } from '../../src/main/secrets/secret-store'
import { FakeOAuthServer } from '../fakes/fake-oauth-server'
import { expect, launchCockpit, type Cockpit } from './fixtures'

const FIXTURE = join(__dirname, '..', 'fixtures', 'plugins', 'host-oauth')
const PLUGIN = 'test.hostoauth'
const CLIENT_ID = 'e2e-oauth-client'
const CLIENT_SECRET = 'e2e-oauth-client-secret-7f2e'

interface Seen {
  accessToken?: string
  expiresAt?: number
  refreshedAccessToken?: string
  keys?: string[]
  error?: string
}

/** Replace shell.openExternal in main with a recorder: nothing may reach the real browser. */
async function stubOpenExternal(c: Cockpit): Promise<() => Promise<string[]>> {
  await c.app.evaluate(({ shell }) => {
    const g = globalThis as { __opened?: string[] }
    g.__opened = []
    shell.openExternal = (url: string) => {
      g.__opened!.push(url)
      return Promise.resolve()
    }
  })
  return () => c.app.evaluate(() => (globalThis as { __opened?: string[] }).__opened ?? [])
}

interface Tls {
  key: string
  cert: string
  /** The certificate's file: NODE_EXTRA_CA_CERTS for the app. */
  certFile: string
}

/**
 * Fixtures, set up in this order and torn down in reverse, so the certificate outlives both:
 *   tls      a key and self-signed certificate for 127.0.0.1 (one day) in a fresh temp dir
 *   server   the fake provider on https with that certificate
 *   cockpit  the app, trusting that one extra certificate (NODE_EXTRA_CA_CERTS)
 */
const test = base.extend<{ tls: Tls; server: FakeOAuthServer; cockpit: Cockpit }>({
  // eslint-disable-next-line no-empty-pattern
  tls: async ({}, use) => {
    const dir = mkdtempSync(join(tmpdir(), 'ccc-e2e-tls-'))
    const keyFile = join(dir, 'key.pem')
    const certFile = join(dir, 'cert.pem')
    try {
      // argv only; -nodes: an unencrypted key (no passphrase prompt); piped so a failure says why.
      execFileSync(
        'openssl',
        ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-days', '1',
          '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'],
        { stdio: 'pipe' }
      )
      await use({ key: readFileSync(keyFile, 'utf8'), cert: readFileSync(certFile, 'utf8'), certFile })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
  server: async ({ tls }, use) => {
    const server = await new FakeOAuthServer({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      tls: { key: tls.key, cert: tls.cert }
    }).start()
    try {
      await use(server)
    } finally {
      await server.stop()
    }
  },
  // Depends on `server` too, only so the provider listens before the app starts and stops after
  // it quits.
  cockpit: async ({ tls, server }, use) => {
    void server
    const { cockpit, close } = await launchCockpit({ env: { NODE_EXTRA_CA_CERTS: tls.certFile } })
    try {
      await use(cockpit)
    } finally {
      await close()
    }
  }
})

test('ctx.oauth: a sign-in cut off by a host restart, then one completed, refreshed and stored with ctx.secrets', async ({ cockpit, server }) => {
  const opened = await stubOpenExternal(cockpit)
  const record = join(cockpit.root, 'home', 'host-oauth.json')
  const seen = (): Seen => JSON.parse(readFileSync(record, 'utf8')) as Seen
  const active = async (): Promise<void> => {
    await expect
      .poll(() => cockpit.hook<HostStatus>('hostStatus', cockpit.projectDir), { timeout: 15_000 })
      .toMatchObject({ running: true, plugins: [{ id: PLUGIN, state: 'active' }] })
    // The command is registered with main right after activate (an RPC of its own).
    await expect
      .poll(async () => (await cockpit.hook<{ id: string }[]>('pluginCommands', cockpit.projectDir)).map((c) => c.id), { timeout: 10_000 })
      .toContain(`${PLUGIN}/signin`)
  }

  await cockpit.hook('linkPlugin', FIXTURE)
  // The fake's dynamic URLs and the client, saved as the This project form would.
  const saved = await cockpit.hook<{ ok: boolean }>(
    'savePluginProjectSettings',
    cockpit.projectDir,
    PLUGIN,
    { authUrl: server.authUrl, tokenUrl: server.tokenUrl, clientId: CLIENT_ID },
    { clientSecret: CLIENT_SECRET }
  )
  expect(saved).toMatchObject({ ok: true })
  expect(server.tokenUrl).toMatch(/^https:\/\/127\.0\.0\.1:\d+\/token$/)
  await cockpit.hook('enablePlugin', cockpit.projectDir, PLUGIN)
  await active()

  // --- Cut off: the browser is opened, then the host restarts (a window close does the same). ---
  await cockpit.hook('runPluginCommand', cockpit.projectDir, `${PLUGIN}/signin`)
  await expect.poll(async () => (await opened()).length, { timeout: 10_000 }).toBe(1)
  const cutUrl = (await opened())[0]!
  await cockpit.hook('enablePlugin', cockpit.projectDir, PLUGIN)
  // The old copy's sign-in ended with it: main's cancel, or its ctx disposed in the deactivate
  // (that rejects at once), whichever reaches the plugin first.
  await expect.poll(() => existsSync(record), { timeout: 10_000 }).toBe(true)
  expect(seen().error).toMatch(/cancelled|the plugin is deactivated/)
  rmSync(record)
  // Its loopback closed: a browser finishing the consent late finds nobody listening, so no code
  // is exchanged and the provider never sees a token request.
  await expect(server.browse(cutUrl)).rejects.toThrow()
  expect(server.tokenRequests).toEqual([])
  await active()

  // --- Sign in: the restart did not leave a sign-in "in progress". ---
  await cockpit.hook('runPluginCommand', cockpit.projectDir, `${PLUGIN}/signin`)
  await expect.poll(async () => (await opened()).length, { timeout: 10_000 }).toBe(2)
  const authUrl = new URL((await opened())[1]!)
  // What main asked the provider for: the plugin's auth URL (its own query kept), its client id
  // (never the secret: that goes only to the token endpoint), PKCE S256, and a loopback redirect
  // on 127.0.0.1 (never `localhost`); a fresh state per attempt.
  expect(authUrl.origin + authUrl.pathname).toBe('https://auth.fake.test/authorize')
  expect(authUrl.searchParams.get('access_type')).toBe('offline')
  expect(authUrl.searchParams.get('client_id')).toBe(CLIENT_ID)
  expect(authUrl.searchParams.get('scope')).toBe('read')
  expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256')
  expect(authUrl.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
  expect(authUrl.toString()).not.toContain(CLIENT_SECRET)
  expect(authUrl.searchParams.get('state')).not.toBe(new URL(cutUrl).searchParams.get('state'))

  // The browser: consent, then the redirect to the loopback, which answers with its fixed page.
  const landing = await server.browse(authUrl.toString())
  expect(landing.status).toBe(200)

  await expect.poll(() => existsSync(record), { timeout: 15_000 }).toBe(true)
  const result = seen()
  expect(result.error).toBeUndefined()
  expect(result.accessToken).toMatch(/^access-/)
  expect(result.refreshedAccessToken).toMatch(/^access-/)
  expect(result.refreshedAccessToken).not.toBe(result.accessToken)
  expect(result.expiresAt).toBeGreaterThan(Date.now())
  expect(result.keys).toEqual(['fake:refresh'])
  // One code exchange with the verifier and the client secret from the secret field (the fake
  // checks both), then one refresh with the token the plugin stored and read back.
  expect(server.tokenRequests.map((r) => r.grant_type)).toEqual(['authorization_code', 'refresh_token'])
  expect(server.tokenRequests[0]!.client_secret).toBe(CLIENT_SECRET)
  const [refreshToken] = [...server.validRefreshTokens]
  expect(refreshToken).toBeDefined()
  expect(server.tokenRequests[1]!.refresh_token).toBe(refreshToken)

  // The refresh token and the client secret are on disk only as (fake) ciphertext.
  const secretsText = readFileSync(join(cockpit.dataDir, 'secrets.json'), 'utf8')
  expect(secretsText).toContain(FAKE_PREFIX)
  expect(secretsText).not.toContain(refreshToken!)
  expect(secretsText).not.toContain(CLIENT_SECRET)
  const stored = Object.keys((JSON.parse(secretsText) as { plugins: Record<string, Record<string, string>> }).plugins[PLUGIN] ?? {})
  expect(stored.sort()).toEqual(['fake:refresh', expect.stringMatching(/^setting:project:[^:]+:clientSecret$/)])
})
