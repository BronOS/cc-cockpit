# The ccc command line

`ccc` talks to the running app over a local socket. Inside a tab of any kind (Claude, shell or a
custom command tab) and in a terminal overlay it knows which window you are in; outside the app,
name the project with `--project <path>` (`overlay` takes it after its name, a plugin command
before it: `ccc --project <path> <plugin command> …`). Only a Claude tab is a Claude session:
`session note` and `session steps` are refused anywhere else, and a `hook` from there records
nothing (it still exits 0).
When the app is not running every command except `guide` and `help` exits 0 silently.

Exit codes: 0 done (or the app is not running), 1 the app refused the request or `ccc` crashed,
2 a usage error (the message and the usage text go to stderr).

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
- `ccc overlay --url <http(s) url>` shows a web page in an overlay.
- `ccc overlay --html <file>` shows a local html file (read once, shown through a privileged
  scheme) and returns what the page answers with.
- `ccc sessions [--json]` lists the Claude tabs of every window and their status.
- `ccc notify <text>` shows a system notification.
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
- `ccc hook <Event>` is internal: the app's Claude hooks call it. Do not run it by hand.

## Things to know

- After an upgrade over a running app, a command warns on stderr that the app and `ccc` are
  different versions, then runs as usual: stdout and the exit code do not change. Restart the app.
- Text for `session note` and `notify` is one value; it is never run through a shell.
- Paths you pass are resolved against your current directory by `ccc`, not by the app.
- Plugins can add commands of their own (`contributes.cli`, see the `plugins` and `api` topics).
  Their names never shadow a core command.
- You cannot type into a Claude session through `ccc`. The app delivers text only to a session
  that is waiting for input (plugins use `ctx.sessions.send` for that).
