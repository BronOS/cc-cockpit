// Fixture plugin for the ctx.oauth e2e: its "signin" command signs in with the client its project
// settings name (the spec writes the fake provider's URLs there, the client secret through a
// secret field), keeps the refresh token with ctx.secrets, refreshes once with the stored token,
// and records what it saw in $HOME (a temp dir in the e2e run) so the spec can check it.
const fs = require('node:fs')
const path = require('node:path')

const record = (seen) => fs.writeFileSync(path.join(process.env.HOME, 'host-oauth.json'), JSON.stringify(seen))

async function signIn(ctx) {
  const s = ctx.settings.project
  const spec = { authUrl: s.authUrl, tokenUrl: s.tokenUrl, clientId: s.clientId, clientSecret: s.clientSecret, scopes: ['read'] }
  const seen = {}
  try {
    const tokens = await ctx.oauth.authorize(spec)
    seen.accessToken = tokens.accessToken
    seen.expiresAt = tokens.expiresAt
    await ctx.secrets.set('fake:refresh', tokens.refreshToken)
    const fresh = await ctx.oauth.refresh(spec, await ctx.secrets.get('fake:refresh'))
    seen.refreshedAccessToken = fresh.accessToken
    seen.keys = await ctx.secrets.keys()
  } catch (err) {
    seen.error = String(err && err.message ? err.message : err)
  }
  record(seen)
}

exports.activate = (ctx) => {
  // Not awaited: the sign-in waits for the test to play the browser, and the test hook that runs
  // the command awaits the command.
  ctx.commands.register('signin', () => {
    void signIn(ctx)
  })
}
