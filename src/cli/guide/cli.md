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
  passed through (124: it did not answer within 30 s). Its stdin is read only when the plugin
  declares it (at most 256 KiB).
- `ccc plugin new <dir> [--id <id>] [--panel] [--cli <name>] [--skill]` scaffolds a plain-JS plugin
  into an empty folder (no app needed). `ccc plugin link [--project <path>] <dir>` links it and
  enables it in this project after a person confirms in the app window (waits for the answer;
  Deny exits 1 "declined"). `ccc plugin unlink <id>` removes a linked plugin. `ccc plugin list
  [--json]` shows the installed plugins and whether each is enabled here. `ccc plugin logs <id>
  [--follow]` prints a plugin's log. See `ccc guide dev-loop`.
- `ccc hook <Event>` is internal: the app's Claude hooks call it. Do not run it by hand.

## Things to know

- Text for `session note` and `notify` is one value; it is never run through a shell.
- Paths you pass are resolved against your current directory by `ccc`, not by the app.
- Plugins can add commands of their own (`contributes.cli`, see the `plugins` and `api` topics).
  Their names never shadow a core command.
- You cannot type into a Claude session through `ccc`. The app delivers text only to a session
  that is waiting for input (plugins use `ctx.sessions.send` for that).
