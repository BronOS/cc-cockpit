# The ccc command line

`ccc` talks to the running app over a local socket. Inside a tab of any kind (Claude, shell or a
custom command tab) and in a terminal overlay it knows which window you are in; outside the app,
name the project with `--project <path>` (`overlay` takes it after its name, a plugin command
before it: `ccc --project <path> <plugin command> …`). Only a Claude tab is a Claude session:
`session note` and `session steps` are refused anywhere else, and a `hook` from there records
nothing (it still exits 0).
When the app is not running every command except `guide`, `help` and `web` exits 0 silently.

Exit codes: 0 done (or the app is not running), 1 the app refused the request or `ccc` crashed
(and `ccc web` when the app is not running), 2 a usage error (the message and the usage text go to
stderr).

## Commands

- `ccc help` prints the usage text; `ccc <command> --help` prints that command's usage line.
- `ccc guide [topic]` prints this documentation. No topic: the overview and the topic list.
- `ccc open <path>` opens (or focuses) a folder as a project in its own window.
- `ccc session note <text>` adds a line to this Claude tab's entry in the status view. Several words
  need no quotes. Use it to say what you are doing or what is blocking you.
- `ccc session steps <done>/<total>` sets this Claude tab's progress, for example `3/5`. Needs
  `0 <= done <= total` and `total >= 1`.
- `ccc overlay --terminal -- <argv...>` runs a program in an overlay above the window and waits;
  stdout is the result as JSON (`{"kind":"exit","code":0}`, `{"kind":"value",...}` or
  `{"kind":"dismissed"}`).
- `ccc overlay --url <http(s) url>` shows a web page in an overlay. Not in server mode (exit 1,
  "not available in server mode"): give the person the URL, or show it in the Browser panel
  (`ccc browser open`), which works in server mode.
- `ccc overlay --html <file>` shows a local html file (read once, shown through a privileged
  scheme) and returns what the page answers with.
- `ccc sessions [--json]` lists the Claude tabs of every window and their status.
- `ccc notify <text>` shows a system notification. In server mode it is an in-page notice in the
  browsers instead: those with the caller's project open (a tab's, or `--project`), or every
  browser when it names no project; a project with no open window shows it nowhere. It goes after
  10 minutes if nobody dismisses it.
- `ccc [--project <path>] <plugin command> [args...]` runs a command a plugin enabled in this
  project adds. `ccc help` inside a tab lists them; `ccc <plugin command> --help` (a leading `--help` or `-h`; the plugin never receives it) prints its usage
  without running it. Main answers an unknown command, a plugin that is not enabled here or not
  running with exit 1 and the reason; otherwise the plugin's stdout, stderr and exit code are
  passed through (124: it did not answer within 30 s). A plugin that is reloading or still
  starting is waited for within the same 30 s, then the command runs in its new copy (124 if it
  is not active by then). Its stdin is read only when the plugin declares it (with `stdinDash`, only for a `-` argument) and it is not a terminal (at most 256 KiB);
  stdin not closed within 40 s is exit 124, so pipe the input or redirect `</dev/null`.
- `ccc plugin new <dir> [--id <id>] [--panel] [--cli <name>] [--skill]` scaffolds a plain-JS plugin
  into a new folder, or one where no file it writes exists yet (no app needed). `ccc plugin link [--project <path>] <dir>` links it and
  enables it in this project after a person confirms in the app window (waits for the answer;
  Deny exits 1 "declined"). `ccc plugin unlink <id>` removes a linked plugin. `ccc plugin list
  [--json]` shows the installed plugins and whether each is enabled here. `ccc plugin logs <id>
  [--follow]` prints a plugin's log. See `ccc guide dev-loop`.
- `ccc plugin config [--project <path>] <id> [--json]` prints a plugin's settings, one
  `scope key = JSON` line per top-level field: `app` lines first, then `global` (the global value
  of each project field, what every project without an override gets), then `project` (this
  project's effective value: its override, else the global value, else the default) and a
  `# project:` line naming the fields this project overrides. A secret field reads `set` or
  `not set`, never its value; so does a plain field with no value and no default. `--json` prints
  `{ id, app?, global?, project? }`, each scope `{ fields, values, secrets, problem? }` (`secrets`
  maps each secret field to whether it is set; `project` adds `overrides`, the overridden fields).
- `ccc plugin config [--project <path>] <id> [--scope app|global|project] <key>=<value>...` sets
  top-level fields and prints the stored `scope key = JSON` lines. A value is parsed as JSON, else
  taken as text: `limit=5` is a number, `name=hi` the string `hi`, `name='"5"'` the string `5`. The
  scope is the one whose schema declares the key, and a project field defaults to `project` (this
  project's override); `--scope global` sets its global value instead (refused, naming the project,
  when an open project's overrides would no longer validate with it). A key both the app and the
  project schema declare needs `--scope`, and one call sets one scope. `ccc plugin config <id>
  --use-global <key>` (repeatable, alone) drops this project's override so the field uses the
  global value again. The save is the Settings form's: the same schema check over the effective
  values (a refused value exits 1 with the schema's reasons and stores nothing), then the plugin
  gets `ctx.onSettingsChange` in every project whose values changed, or starts if it was off for
  invalid settings. Exit 1 also for an unknown plugin or key, and for a secret field: those are
  set by a person in Settings > Plugins (app and global values) or Settings > This Project, never
  through `ccc`.
- `ccc panel show [--project <path>] <plugin>/<panel>` reveals one of a plugin's panels in this
  project's window: unhidden, opened, its zone expanded, and shown again if the window auto-hid
  it for a narrow terminal (what `ctx.panels.show` does for the
  plugin itself). Exit 1 for an unknown plugin, a plugin not enabled in this project, a project
  with no open window, or a panel the plugin does not declare.
- `ccc web status [--json]`, `ccc web revoke <device id>|--all` and `ccc web stop` are web access
  from a shell on the server, for the person who runs cc-cockpit, not for Claude: inside any
  cockpit tab (Claude, shell or command) they are refused with "run `ccc web` from a shell on the
  server, outside cc-cockpit". `status` prints the app's version, the sign-in mode, the address
  and external origin, whether the gateway listens (or why not), the secret store and how many
  stored values it cannot read, whether the access link and the password are set, whether this is
  server mode, and the signed-in devices (id, name, how each signed in, last seen); never a link, a
  token or a hash. `--json` also has `scheme` (`http` or `https`: TLS on), the gateway's own.
  In server mode the app's own notices (a new device signed in, a plugin the marketplace revoked, a
  newer release) are one stdout line each, in the terminal or journal that runs the app, with no
  OS notification; `status` lists this run's as `notices` (also in `--json`), a new device with its
  id, which names its `sign-in` entry in `web-access.log`. A line holds no link, token or plugin
  text. The desktop keeps its OS notifications and lists none.
  `revoke` signs out one device by the id `status` shows, or all of them. `stop` quits a
  server-mode app as SIGTERM does (open browser tabs reconnect when it is back). On the desktop only
  `status` and `revoke` are answered; the rest says "use Settings › Web access". When the app is
  not running `ccc web` prints "cc-cockpit is not running" and exits 1.
- In server mode `ccc web` also hands out and changes sign-in, again only from a shell on the
  server: `ccc web link [--regenerate]` prints the access link (made on first use; `--regenerate`
  makes a new one and signs out every device that used the old); `ccc web add-device` prints a
  one-time link that works once within 10 minutes. Each prints the link alone on stdout.
  `ccc web password` sets the password from stdin (`echo ... | ccc web password`, one line), or on a
  terminal asks twice with no echo; it never takes the password as an argument (argv shows in
  `ps`). `ccc web mode link|password|none` switches the sign-in mode (`confirm` is refused: nobody
  is at a desktop to answer it; password needs a password set first; `none` on a network address
  takes `--confirm none-network`); `none` prints a warning:
  everyone who can reach the address, every user of the server included, controls cc-cockpit.
  `ccc web set [--bind <addr>] [--port <n>] [--origin <url>] [--host <name>]... [--tls-cert <pem>
  --tls-key <pem> | --no-tls] [--confirm none-network|plain-http]...` changes where it listens, as
  the Settings page does (`--origin ''` clears the origin; `--host` replaces the list; TLS paths are
  taken against the current folder). No sign-in or plain http on a network address is refused with
  the warning text until the same command is run with its `--confirm` (once per risk).
  `ccc web set --start-folder <path>` sets where the browser picker's folder browser starts (taken
  against the current folder; `''` goes back to the default, the server user's home folder; a folder
  that is gone when a browser asks falls back to home with a note); `ccc web status` shows it. Each
  change is written to `web-access.log`, never a link or a password.
- `ccc hook <Event>` is internal: the app's Claude hooks call it. Do not run it by hand.
- `ccc statusline` is internal too: Claude Code runs it as the status line of a cockpit Claude tab
  (while the app setting "Rate limits from the status line" is on). It passes the plan usage, cost
  and context fill to the app (`ctx.sessions.rateLimits`, `SessionInfo.costUsd`) and then runs your
  own status line from your Claude settings (user, project, local) and prints its output, so the
  line looks as it does outside the app. It always exits 0 and prints nothing when you have none.

## Things to know

- After an upgrade over a running app, a command warns on stderr that the app and `ccc` are
  different versions, then runs as usual: stdout and the exit code do not change. Restart the app.
- Text for `session note` and `notify` is one value; it is never run through a shell.
- Paths you pass are resolved against your current directory by `ccc`, not by the app.
- Plugins can add commands of their own (`contributes.cli`, see the `plugins` and `api` topics).
  Their names never shadow a core command.
- You cannot type into a Claude session through `ccc`. The app delivers text only to a session
  that is waiting for input (plugins use `ctx.sessions.send` for that).
