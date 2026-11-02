# browser

The built-in browser plugin (`cockpit.browser`): one webview panel in the right zone, driven by
`ccc browser open <url|file>`, `ccc browser url` and `ccc browser reload`, plus a Claude skill
(`skills/browser`) that tells Claude to use it for showing mock-ups, local HTML files and dev servers.

It ships with the app (bundled source, on by default, turn it off per project in Settings > This
project), so it is never installed or copied. App setting `home`: an http(s) URL loaded when the
plugin starts.

```sh
npm run build:browser        # builds dist/host.js (committed); `npm run build` runs it first
```

`test/unit/browser-plugin.test.ts` rebuilds into a temp dir and compares bytes with the committed
`dist/host.js`. The plugin is also a worked example of `contributes.cli`, `contributes.skills` and
`ctx.webview` (`ccc guide webview`).
