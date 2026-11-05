// The `hello` reference plugin's host side (design §5). It touches most parts of the plugin API
// (not sessions.open, dataDir, log.info, storage.delete/keys or a url overlay), in the
// order a real plugin usually needs it, so read it top to bottom as a template:
//
//   settings        ctx.settings / onSettingsChange (project + app schemas from plugin.json), and
//                   a secret settings field (`apiToken`): the panel learns only "set" or "not set"
//   secrets         ctx.secrets: a counter kept in the keychain-backed store, with keys()
//   oauth           ctx.oauth: documented in a comment only (it would need a real provider)
//   storage         ctx.storage: a per-project visit counter that survives restarts
//   schedule        ctx.schedule + ctx.badge: a tick counter on the panel icon
//   exec            ctx.exec: `git status --short` (argv only, never a shell)
//   sessions        ctx.sessions.list / onChange / send: the panel's session picker and text box
//   overlay         ctx.overlay.open: a terminal overlay and an html overlay that answers
//   commands        ctx.commands.register + ctx.notify: "Hello: Say hello"
//   panels          ctx.panels.post / onMessage: all the above, shown by panels/hello.html
//   settings page   ctx.settingsPage.onOpen: settings/index.html under the forms in Settings, a
//                   note kept with ctx.appStorage (Plugins page) or ctx.storage (This project)
//
// The panel is dumb on purpose: the host keeps one `State`, and every change posts the whole of it.
// A panel that is not shown drops messages (the API says so), so the panel sends `ready` when it
// connects and gets the current state back.
//
// Only TYPES are imported from the SDK: they vanish when esbuild bundles this file
// (scripts/build-hello.mjs), so dist/host.js has no dependency on the app's code.
import type { Disposer, JsonValue, PluginContext, SessionInfo } from '../../../src/sdk/types'

const PANEL = 'hello'

interface State {
  greeting: string
  /** Scheduled runs since the last reset: also what the icon's badge shows. */
  ticks: number
  /** How many times this project's host started this plugin (persisted with ctx.storage). */
  visits: number
  sessions: { tabId: string; status: string; lastPrompt: string }[]
  /** `git status --short` lines, or the reason there are none. */
  git: { lines: string[] } | { error: string } | null
  /** The outcome of the last send / overlay, as a line of text. */
  lastSend: string
  lastOverlay: string
  /**
   * Whether the `apiToken` secret setting has a value. A boolean on purpose: the plugin host sees
   * the plaintext in ctx.settings, but the panel is a web page and must never get it, so the
   * value is not copied into this state (which is posted whole on every change).
   */
  tokenSet: boolean
  /** The counter kept with ctx.secrets (null: not set), and the keys this plugin has in the store. */
  bumps: number | null
  secretKeys: string[]
  /** Set when the secret store failed (the OS cannot decrypt or encrypt), else ''. */
  secretError: string
}

const isObject = (v: JsonValue | undefined): v is { [key: string]: JsonValue } =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

let dispose: Disposer[] = []

export function activate(ctx: PluginContext): void {
  const state: State = {
    greeting: '',
    ticks: 0,
    visits: 0,
    sessions: [],
    git: null,
    lastSend: '',
    lastOverlay: '',
    tokenSet: false,
    bumps: null,
    secretKeys: [],
    secretError: ''
  }

  // --- settings: app and project values, validated and defaulted by the app -------------------
  const greetingOf = (settings: PluginContext['settings']): string => {
    const text = String(settings.project.greeting ?? 'Hello')
    return settings.app.shout === true ? text.toUpperCase() : text
  }
  state.greeting = greetingOf(ctx.settings)

  // A secret field is a plain string in ctx.settings when set and absent when not (an unset
  // required one does not disable the plugin either). Only its presence goes any further.
  const tokenSetOf = (settings: PluginContext['settings']): boolean =>
    typeof settings.app.apiToken === 'string' && settings.app.apiToken !== ''
  state.tokenSet = tokenSetOf(ctx.settings)

  const MAX_GIT_LINES = 200
  const push = (): void => ctx.panels.post(PANEL, { type: 'state', ...state } as unknown as JsonValue)

  // --- schedule + badge ------------------------------------------------------------------------
  // The schedule is re-created when the interval setting changes. `schedule` returns a disposer;
  // all of them are also cleared by the host when the plugin deactivates.
  let stopTicking: Disposer | undefined
  const startTicking = (seconds: number): void => {
    stopTicking?.()
    stopTicking = ctx.schedule(seconds, () => {
      state.ticks += 1
      ctx.badge(PANEL, state.ticks)
      push()
    })
  }
  startTicking(Number(ctx.settings.project.tickSeconds ?? 10))
  dispose.push(() => stopTicking?.())

  let lastTick = Number(ctx.settings.project.tickSeconds ?? 10)
  dispose.push(
    ctx.onSettingsChange((settings) => {
      state.greeting = greetingOf(settings)
      state.tokenSet = tokenSetOf(settings)
      const seconds = Number(settings.project.tickSeconds ?? 10)
      if (seconds !== lastTick) {
        lastTick = seconds
        startTicking(seconds)
      }
      push()
    })
  )

  // --- storage ---------------------------------------------------------------------------------
  const loadVisits = async (): Promise<void> => {
    state.visits = ((await ctx.storage.get<number>('visits')) ?? 0) + 1
    await ctx.storage.set('visits', state.visits)
  }

  // --- secrets ---------------------------------------------------------------------------------
  // ctx.secrets is an app-wide, per-plugin store encrypted with the OS keychain (only main can
  // reach it, so every call is a round trip). Values are strings; here a number is kept as text.
  // It holds credentials, so a real plugin keeps a token or a refresh token here, not a counter:
  // this one only shows get / set / delete / keys. The `setting:` key prefix is reserved for the
  // secret settings fields: readable with get(), but set/delete refuse it and keys() hides it.
  // "bump" reads state.bumps and writes +1, so a second click before the first write has been
  // re-read would write the same number (a lost update): `bumping` drops a click while one is in flight.
  const BUMPS = 'bumps'
  let bumping = false
  const loadSecrets = async (): Promise<void> => {
    try {
      const raw = await ctx.secrets.get(BUMPS)
      const n = raw === null ? NaN : Number(raw)
      state.bumps = Number.isInteger(n) && n >= 0 ? n : null
      state.secretKeys = await ctx.secrets.keys()
      state.secretError = ''
    } catch (err) {
      // get rejects when a stored value cannot be decrypted (a keychain reset); set when the OS
      // cannot encrypt, and then nothing is stored. Show the reason, never a value.
      state.secretError = errorText(err)
    }
  }
  const changeSecret = async (change: () => Promise<void>): Promise<void> => {
    try {
      await change()
    } catch (err) {
      state.secretError = errorText(err)
      return
    }
    await loadSecrets()
  }

  // --- oauth -----------------------------------------------------------------------------------
  // ctx.oauth signs a user in with OAuth 2.0 (authorization code + PKCE) and is not called here,
  // since it would open a browser on a real provider. The shape of a plugin that uses it:
  //
  //   const spec: OAuthSpec = {
  //     authUrl: 'https://accounts.example.com/oauth/authorize',   // https only, no user:password
  //     tokenUrl: 'https://accounts.example.com/oauth/token',
  //     clientId: String(ctx.settings.app.clientId),
  //     // Keep a client secret in a secret settings field, never in the source:
  //     clientSecret: String(ctx.settings.app.clientSecret ?? ''),
  //     scopes: ['read']
  //   }
  //   // Opens the system browser, waits for the redirect to 127.0.0.1 and exchanges the code.
  //   // Rejects on timeout (5 min), refusal, a second authorize while one is pending, 5 a minute,
  //   // and when this ctx is disposed (deactivate, reload, a failed activate): sign in from a command.
  //   const tokens = await ctx.oauth.authorize(spec)       // { accessToken, refreshToken, expiresAt }
  //   // Storing the tokens is the plugin's job: ctx.secrets, not ctx.storage (plain JSON on disk).
  //   await ctx.secrets.set('refresh-token', tokens.refreshToken ?? '')
  //   // Later, when expiresAt has passed (a null refreshToken from refresh means "not rotated",
  //   // keep the old one; an `invalid_grant` error means the user has to sign in again):
  //   const fresh = await ctx.oauth.refresh(spec, (await ctx.secrets.get('refresh-token')) ?? '')

  // --- exec ------------------------------------------------------------------------------------
  const refreshGit = async (): Promise<void> => {
    try {
      // An argv array: nothing here is parsed by a shell, so a path with spaces or `;` is harmless.
      const result = await ctx.exec(['git', 'status', '--short'], { timeoutMs: 15_000 })
      // Cap what goes into the state: panels.post throws over 1 MiB, so one huge `git status`
      // would make every push fail and the panel would never get any state.
      const all = result.stdout.split('\n').filter(Boolean)
      const lines =
        all.length > MAX_GIT_LINES ? [...all.slice(0, MAX_GIT_LINES), `... ${all.length - MAX_GIT_LINES} more`] : all
      state.git =
        result.code === 0
          ? { lines }
          : { error: result.stderr.trim() || `git exited with ${result.code}` }
    } catch (err) {
      // exec rejects when the program cannot start (no git installed) or its output passes 10 MiB.
      state.git = { error: errorText(err) }
    }
  }

  // --- sessions --------------------------------------------------------------------------------
  const setSessions = (list: SessionInfo[]): void => {
    state.sessions = list.map((s) => ({ tabId: s.tabId, status: s.status, lastPrompt: s.lastPrompt ?? '' }))
  }
  dispose.push(
    ctx.sessions.onChange((list) => {
      setSessions(list)
      push()
    })
  )

  // --- overlays --------------------------------------------------------------------------------
  const describe = (result: Awaited<ReturnType<PluginContext['overlay']['open']>>): string => {
    switch (result.kind) {
      case 'exit':
        return `terminal overlay exited with ${result.code}`
      case 'value':
        return `html overlay answered ${JSON.stringify(result.value)}`
      case 'dismissed':
        return 'overlay dismissed'
      case 'discussed':
        return 'overlay discussed with Claude'
    }
  }
  const openOverlay = async (kind: 'terminal' | 'html'): Promise<void> => {
    state.lastOverlay = `${kind} overlay open...`
    push()
    try {
      const result =
        kind === 'terminal'
          ? // The program is a fixed script and the overlay closes when it ends, so it waits for Enter.
            // Never interpolate a file name or branch into this script: that is shell injection and
            // CLAUDE.md says exec is argv-only. Pass values as extra argv and read them as "$1".
            await ctx.overlay.open({
              kind: 'terminal',
              argv: ['sh', '-c', 'git --no-pager status; printf "\\nPress Enter to close. "; read _'],
              title: 'git status'
            })
          : await ctx.overlay.open({ kind: 'html', file: 'panels/pick.html', title: 'Pick a colour' })
      state.lastOverlay = describe(result)
    } catch (err) {
      state.lastOverlay = `overlay failed: ${errorText(err)}`
    }
    push()
  }

  // --- messages from the panel (untrusted: check every field) ----------------------------------
  dispose.push(
    ctx.panels.onMessage(PANEL, (message) => {
      if (!isObject(message)) return
      switch (message.type) {
        case 'ready':
          void (async () => {
            setSessions(await ctx.sessions.list())
            push()
          })().catch((err) => ctx.log.error('ready:', errorText(err)))
          break
        case 'git':
          void refreshGit().then(push)
          break
        case 'bump':
          if (bumping) break
          bumping = true
          void changeSecret(() => ctx.secrets.set(BUMPS, String((state.bumps ?? 0) + 1)))
            .finally(() => {
              bumping = false
            })
            .then(push)
          break
        case 'forget-bumps':
          void changeSecret(() => ctx.secrets.delete(BUMPS)).then(push)
          break
        case 'overlay':
          if (message.kind === 'terminal' || message.kind === 'html') void openOverlay(message.kind)
          break
        case 'reset':
          state.ticks = 0
          ctx.badge(PANEL, null)
          push()
          break
        case 'send':
          if (typeof message.tabId === 'string' && typeof message.text === 'string') {
            // The app types the text only while that tab waits for input; otherwise it queues it
            // and types it at the tab's next Stop. It refuses text that starts with "/", "!", "#" or "&".
            ctx.sessions.send(message.tabId, message.text).then(
              (res) => {
                state.lastSend = 'delivered' in res ? 'delivered' : 'queued'
                push()
              },
              (err) => {
                state.lastSend = `refused: ${errorText(err)}`
                push()
              }
            )
          }
          break
      }
    })
  )

  // --- settings page ---------------------------------------------------------------------------
  // settings/index.html (manifest `contributes.settings.page`) shows under the schema forms. It has
  // no settings API: this backend keeps what it edits, per scope (app-wide on the Plugins page, per
  // project on This project), checks it, and answers. Never post a secret to a page. Older apps
  // have no ctx.settingsPage, hence the check.
  if (typeof ctx.settingsPage === 'object') {
    dispose.push(
      ctx.settingsPage.onOpen((page) => {
        const store = page.scope === 'app' ? ctx.appStorage : ctx.storage
        const show = (saved: boolean): void => {
          store.get<string>('note').then(
            (note) => page.post({ scope: page.scope, note: note ?? '', saved }),
            (err) => page.post({ scope: page.scope, error: errorText(err) })
          )
        }
        page.onMessage((message) => {
          if (!isObject(message)) return
          if (message.type === 'ready') show(false)
          if (message.type === 'save' && typeof message.note === 'string') {
            // The page is untrusted input like any other: capped here, not only by its own field.
            store.set('note', message.note.slice(0, 200)).then(
              () => show(true),
              (err) => page.post({ scope: page.scope, error: errorText(err) })
            )
          }
        })
      })
    )
  }

  // --- commands --------------------------------------------------------------------------------
  dispose.push(
    ctx.commands.register('say-hello', () => {
      // Return the promise: notify rejects when rate limited (10 a minute) and the host awaits the
      // handler, so the failure is reported instead of becoming an unhandled rejection.
      return ctx.notify(`${state.greeting} from ${ctx.pluginId}`)
    })
  )

  // --- start up --------------------------------------------------------------------------------
  // activate() has a 10 s limit and must not wait for slow work: these run on after it returns,
  // and each failure is logged, never thrown (a throw here would mark the plugin as failed).
  void Promise.all([loadVisits(), loadSecrets(), refreshGit(), ctx.sessions.list().then(setSessions)])
    .then(push)
    .catch((err) => ctx.log.error('startup:', errorText(err)))
}

export function deactivate(): void {
  for (const d of dispose) d()
  dispose = []
}
