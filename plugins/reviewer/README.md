# Reviewer

A cc-cockpit plugin (`cockpit.reviewer`), scaffolded by `ccc plugin new`.

- `plugin.json`: the manifest (`ccc guide plugins`).
- `dist/host.js`: the plugin host code, plain JavaScript run as is (`ccc guide api`).
- `ccc review`: a command this plugin adds, handled in `dist/host.js`.

Development happens in the app repo: `cockpit.reviewer` is a bundled plugin, and `cockpit.` ids are
reserved, so `ccc plugin link` (and any folder, git or marketplace install) refuses it. Edit
`plugins/reviewer` in place; a dev build (`npm run dev`, or `npm run build` and launch) loads this
folder as the bundled copy, with no linking. The host (`dist/`) is plain JavaScript run as is; after
editing the overlay page (`src/page/`), run `npm run build:reviewer` and commit the rebuilt
`overlay/review.bundle.js`. A host change takes effect when the project's plugin host restarts
(turn the plugin off and on in the project, or restart the app). `npm run test:plugins` runs the
tests in `test/`; `ccc plugin logs cockpit.reviewer --follow` shows what it logs.
