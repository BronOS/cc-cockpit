# Settings, secrets and sign-in

## Settings

`contributes.settings.project` and `.app` are JSON Schemas (objects with `properties`). The app
renders the forms from them; for what a form cannot hold, add an html page under them (see
"Settings page" below). Project settings are per project, app settings are shared. The host reads them as `ctx.settings.project` / `.app`, with
defaults applied, and hears changes through `ctx.onSettingsChange`.

What the form renders (the app's form is rjsf with main as the only validator; it renders one
field per property of the root object):

- `title` is the label (the property name when absent); `description` is shown between the label
  and the input; `default` is the starting value.
- `string` is a text input; `boolean` a checkbox; `number` a number input (any step) and `integer`
  one with step 1; `minimum` and `maximum` are set on the input. An `array` gets Add, and per item
  Move up / Move down / Remove; an item of an array of objects is a box of its fields, and when
  `items` has a `title` ("Rule") the buttons use it ("Add Rule", "Remove Rule 2"). An array with
  `uniqueItems` whose `items` have an `enum` is a multi-select. A nested `object` is a group of its
  own fields; an array's or a nested object's `title` is the group's heading.
- `"format": "multiline"` on a string property (anywhere: top level, nested, in `items`) is a
  text area that grows with its text, for a profile, a prompt or a question's wording. It is a
  form hint only: main does not check formats, so the value is any string within `maxLength`
  (with an `enum` the drop-down stays).
- `"format": "sound"` on a string property (anywhere) is the notification sound picker of the
  app's own setting: "App default" (stored as `""`), then the built-in tones (`builtin:chime`,
  `builtin:bell`, `builtin:ping`, `builtin:pop`, `builtin:two-tone`, `builtin:marimba`) and the
  system's sound files, with ▶ Play. Pass the value to `ctx.notify(text, { sound: value })`
  (`api` topic); main checks it there, so any stored string is harmless. The field has exactly
  `"type": "string"`, no keyword but `type`, `format`, `title`, `description`, `default`,
  `$comment`, and a `default` of `""` or a built-in id (never a system file: those differ per
  machine). An app before 0.9.5 shows a text input and ignores the value in `ctx.notify`. For an
  on/off switch, add a boolean beside it: the person's "Notification sounds" off silences all.
- `enum` is a drop-down that shows the raw values: `enumNames` is ignored. For display labels write
  the choices as `"oneOf": [{ "const": "a", "title": "Alpha" }, { "const": "b", "title": "Beta" }]`
  on the property (with `"type": "string"`): the drop-down shows the titles and stores `a` / `b`.
  Give such a property a `default`: with none, the form shows the first choice as selected and a
  save stores it.
- No conditional fields. The form cannot hide a field depending on another one: the browser side has no
  validator, so `if`/`then`/`else` always shows the `then` fields, and `dependencies` /
  `dependentSchemas` / a `oneOf` of branches show nothing extra. Main still validates a save
  against the whole schema (`if`/`then` constraints do apply), so use them only as rules. For
  "Custom base URL only when endpoint = custom" declare the field always and say so in its
  `description`, and check it in the host.

Limits: schemas may not use regular expressions (`pattern`, `patternProperties`), because a
pathological one would hang the main process. Use `enum`, `minimum`, `maxLength` and friends.

## Settings page

For what a form cannot hold (a rules editor, a list with drag and drop), declare an html page:

```json
"settings": { "app": { ... }, "project": { ... },
  "page": { "entry": "settings/index.html", "scopes": ["app", "project"] } }
```

- It needs `main`, and `entry` is an `.html` file in your folder. `scopes`: `app` shows it under the
  app form on Settings > Plugins (your plugin's Settings), `project` under the project form on
  Settings > This Project; one or both.
- It is a sandboxed iframe like a panel: `cc-plugin://`, the panel CSP, the panel SDK
  (`/__sdk/panel.js`: `ccPanel.post` / `ccPanel.onMessage`, the theme and the component sheet). Its
  port goes to your backend in this window's host: `ctx.settingsPage.onOpen((page) => …)` with
  `page.scope`, `post`, `onMessage`, `onClose` (`api` topic). One page of a plugin is open at a time.
- The page has no settings API of its own. Store what it edits yourself, `ctx.appStorage` for the
  app scope and `ctx.storage` for the project scope, and validate every message (the page is
  untrusted input). `ctx.settings` stays the schema form's.
- Never post a secret value to the page: a page is a web page. Keep secrets in a `"format":
  "secret"` field or `ctx.secrets`, and tell the page only whether one is set.
- A plugin not enabled in the window's project has no backend there: the page shows "Enable
  <plugin> in this project to edit this page" (the schema form still works).

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
  `ctx.settings`. An unset secret does not make the settings invalid: at `activate` (and in any
  snapshot) its key is simply absent, so `ctx.settings.app.apiToken === undefined` and
  `'apiToken' in ctx.settings.app` is false. It is never `''` or `null`: an empty value typed in
  the form is no change, and Clear removes the key. After the person sets it, `ctx.onSettingsChange`
  fires with the key present. `ccc plugin config` cannot set it.

## `ctx.secrets`

Encrypted key-value store, app-wide per plugin (every project sees the same keys). For
per-project sign-ins name keys yourself (`google:work`) and let a project setting pick one. Keys
`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`, values at most 64 KiB, at most 100 keys. `set` rejects when
the OS cannot encrypt: plaintext is never stored, and there is no plaintext or key-file fallback
by design, so do not build one. Uninstalling a plugin deletes its secrets.

### When the OS keyring is unavailable

On Linux the secrets need a running Secret Service keyring (gnome-keyring, or KeePassXC with its
Secret Service integration) or KWallet, unlocked. Without one, `ctx.secrets.set` and a secret
settings field reject with "cannot store secrets: ..." naming the fix. The app uses the Secret
Service on its own when it is on the session bus, even under a desktop Electron does not know
(Hyprland, sway); otherwise the user starts a keyring, or launches the app with
`--password-store=gnome-libsecret` (`kwallet6` for KDE 6). A plugin should show that message and
let the user retry after fixing it; it must not keep the secret in a file or in `ctx.storage`.

## Sign-in flows

- Token style: one secret settings field.
- OAuth: `ctx.oauth.authorize({ authUrl, tokenUrl, clientId, clientSecret?, scopes })` opens the
  system browser, catches the loopback redirect and exchanges the code (PKCE). Both URLs are
  https. Keep the client secret in a secret field. Store the returned tokens with
  `ctx.secrets`; renew with `ctx.oauth.refresh(spec, refreshToken)`. The result has `scope` (the
  granted scopes) when the provider sends it: check for a scope you need, the person may untick it. One `authorize` at a time
  (a new one cancels the pending one, so a "Sign in again" button works when the provider shows
  an error page and never redirects), 5 a minute.
- CLI login (`gh auth login`): open a terminal overlay with `ctx.overlay.open` and check the
  result with `ctx.exec`.

## Trust

Plugins enabled in the same project share one host and can read each other's secrets. Install
only code you trust.
