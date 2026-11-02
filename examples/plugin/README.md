# cc-cockpit plugin example

A small, complete plugin for [cc-cockpit](https://github.com/BronOS/cc-cockpit), and a starting point for your own. It
is a click counter: one panel, one setting, one command, per-project storage and a badge on the panel icon. It runs no
programs, reads no files and uses no network.

## Files

| File | What it is |
| --- | --- |
| `plugin.json` | The manifest: id, version, API major, and what the plugin adds to the app. |
| `src/host.ts` | The host side: Node code that runs in its own process. Start reading here. |
| `panels/main.html`, `panels/main.js` | The panel page. Script must be in a separate file: the page's CSP allows no inline script and no network. |
| `icons/example.svg` | The panel's icon. |
| `sdk/types.ts` | The plugin API's types, copied from the app. It is the reference for everything `ctx` offers. |
| `dist/host.js` | The built host, committed: the app runs it as it is and compiles nothing on install. |

## Make it yours

1. Click **Use this template** on GitHub, then clone your new repo.
2. Run `npm install`.
3. In `plugin.json`, change `id` (keep it yours, like `yourname.tool`), `name` and `version`.
4. Edit `src/host.ts` and the panel, then run `npm run typecheck` and `npm run build`.
5. In the app, open Settings > Plugins > **Link folder…** and pick this folder. Then enable the plugin in the
   project's settings. A linked folder is watched, so the plugin restarts after each rebuild.

Inside a cc-cockpit Claude tab, `ccc guide` has the full guide: `ccc guide api`, `ccc guide panels` and
`ccc guide settings-secrets` cover what this example leaves out, such as running programs, secrets, sign-ins, sending
text to Claude sessions and `ccc` commands.

A plugin runs with full access to the user's computer. Treat text from outside as untrusted, and run programs through
`ctx.exec` with an argument list.

## Publish it

1. Commit `dist/host.js`, then tag the commit: `git tag v1.0.0 && git push --tags`.
2. Try the tag with Settings > Plugins > Install from git URL.
3. Open a PR on [cc-cockpit-marketplace](https://github.com/BronOS/cc-cockpit-marketplace) adding your entry. Its
   README has the format and the rules.

## Licence

MIT, see [LICENSE](LICENSE).
