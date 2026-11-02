# Settings, secrets and sign-in

## Settings

`contributes.settings.project` and `.app` are JSON Schemas (objects with `properties`). The app
renders the forms from them; there are no plugin-owned settings pages. Project settings are per
project, app settings are shared. The host reads them as `ctx.settings.project` / `.app`, with
defaults applied, and hears changes through `ctx.onSettingsChange`.

Limits: schemas may not use regular expressions (`pattern`, `patternProperties`), because a
pathological one would hang the main process. Use `enum`, `minimum`, `maxLength` and friends.

## Secret fields

A top-level string property with `"format": "secret"` is a password field:

```json
"apiToken": { "type": "string", "format": "secret", "title": "API token" }
```

- Only on a top-level string property, with no `default` and no keyword but `type`, `format`,
  `title`, `description`, `$comment`.
- A schema with a secret field holds no `$ref`, `$anchor`, `$id` or other reference keyword.
- The value is stored encrypted, never in a settings file, never sent to a renderer (the form
  shows Set / Not set with Replace and Clear). The plugin host gets the plaintext in
  `ctx.settings`. An unset secret does not make the settings invalid.

## `ctx.secrets`

Encrypted key-value store, app-wide per plugin (every project sees the same keys). For
per-project sign-ins name keys yourself (`google:work`) and let a project setting pick one. Keys
`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`, values at most 64 KiB, at most 100 keys. `set` rejects when
the OS cannot encrypt: plaintext is never stored. Uninstalling a plugin deletes its secrets.

## Sign-in flows

- Token style: one secret settings field.
- OAuth: `ctx.oauth.authorize({ authUrl, tokenUrl, clientId, clientSecret?, scopes })` opens the
  system browser, catches the loopback redirect and exchanges the code (PKCE). Both URLs are
  https. Keep the client secret in a secret field. Store the returned tokens with
  `ctx.secrets`; renew with `ctx.oauth.refresh(spec, refreshToken)`. One `authorize` at a time,
  5 a minute.
- CLI login (`gh auth login`): open a terminal overlay with `ctx.overlay.open` and check the
  result with `ctx.exec`.

## Trust

Plugins enabled in the same project share one host and can read each other's secrets. Install
only code you trust.
