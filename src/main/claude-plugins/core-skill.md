---
name: cc-cockpit
description: You are running inside cc-cockpit, a desktop app that hosts this Claude Code session in a terminal tab. Use when asked to operate the app, run `ccc`, open overlays or tabs, notify the user, or write, link and debug a cc-cockpit plugin. Run `ccc guide` first; it documents the CLI and the plugin API.
---

# cc-cockpit

This session runs in a tab of cc-cockpit (one window per project folder). `ccc` is on your PATH
and talks to the app that started you. Everything you need is in `ccc guide`, which works even
when the app is closed. Read the topic that matches the task before acting:

| Task | Run |
|---|---|
| What the app is, rules for a session in a tab | `ccc guide` (or `ccc guide overview`) |
| Every `ccc` command and its flags | `ccc guide cli`, `ccc help`, `ccc <command> --help` |
| Writing a plugin: manifest, host, build | `ccc guide plugins` |
| The full `ctx` reference for a plugin host | `ccc guide api` |
| Panel pages and the `ccPanel` SDK | `ccc guide panels` |
| Settings forms, secret fields, `ctx.secrets`, OAuth | `ccc guide settings-secrets` |
| Linking, rebuilding and debugging a plugin | `ccc guide dev-loop` |
| Webview panels: web pages and local files in a panel | `ccc guide webview` |

`ccc help` also lists the commands this project's plugins add, while the app is running.

Rules:

- `ccc` exits 0 and prints nothing when the app is not running: no output means the app is
  closed, not that the command worked.
- Never type into another tab's session; other tabs and windows are not yours.
- A plugin runs with full Node access: linking or installing one is the user's decision, never
  yours alone.
