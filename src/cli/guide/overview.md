# cc-cockpit

cc-cockpit is a desktop app that runs Claude Code in terminal tabs, one window per project (a
project is a folder). Beside the tabs it shows a core status view of every Claude session
(working, waiting for input, needs permission) and hosts plugins. Plugins add panels, commands,
settings, themes and their own `ccc` subcommands.

You are probably running inside one of its tabs. `ccc` is on your PATH there.

## What core does and what plugins do

Core is only the foundation: tabs, sessions, the status view, the layout, settings, a secrets
store, overlays and the plugin system. Everything else (Jira, mail, a file tree, ...) is a plugin.
There are no accounts in core: a plugin that needs a sign-in brings its own.

## Rules for you, a Claude session in a tab

- Run `ccc help` for the commands. Run `ccc <command> --help` for one command's usage line.
- Run `ccc guide <topic>` for the details. `ccc guide` works with the app closed.
- Other tabs and windows are not yours: never type into another session.
- `ccc` exits 0 and prints nothing when the app is not running, so a missing reply means the
  app is closed, not that the command worked.
