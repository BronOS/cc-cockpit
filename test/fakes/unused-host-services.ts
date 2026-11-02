// HostApiDeps services a test does not exercise: every call rejects, so a test that reaches one
// by mistake fails loudly instead of passing on a silent default.
import type { PluginOAuthApi } from '../../src/main/oauth/plugin-oauth'
import type { PluginSecretsApi } from '../../src/main/secrets/plugin-secrets'

const unused = async (): Promise<never> => {
  throw new Error('not used in this test')
}

export const unusedSecrets: PluginSecretsApi = { get: unused, set: unused, delete: unused, keys: unused }

export const unusedOAuth: PluginOAuthApi = { authorize: unused, refresh: unused }
