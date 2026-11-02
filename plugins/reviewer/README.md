# Reviewer

A cc-cockpit plugin (`cockpit.reviewer`), scaffolded by `ccc plugin new`.

- `plugin.json`: the manifest (`ccc guide plugins`).
- `dist/host.js`: the plugin host code, plain JavaScript run as is (`ccc guide api`).
- `ccc review`: a command this plugin adds, handled in `dist/host.js`.

Link it from a cc-cockpit tab: `ccc plugin link <this folder>` (the app asks the person to allow
it). From then on the app reloads the plugin whenever a file here changes; `ccc plugin logs
cockpit.reviewer --follow` shows what it logs, `ccc plugin unlink cockpit.reviewer` removes it again.
