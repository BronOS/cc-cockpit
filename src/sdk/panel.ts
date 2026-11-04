// The panel SDK as plugins load it: `<script src="/__sdk/panel.js"></script>` in a panel page or
// a plugin's html overlay page, then `window.ccPanel`:
//
//   ccPanel.post(message)                send JSON to the plugin's host (`ctx.panels.onMessage`);
//                                        in an html overlay, `post({ result: value })` closes the
//                                        overlay and `ctx.overlay.open` resolves with that value
//   ccPanel.onMessage(fn)                what the host sends (`ctx.panels.post`); returns unsubscribe
//   ccPanel.theme.current                { kind, vars }: the app theme, already applied to :root
//   ccPanel.theme.onChange(fn)           a new theme (applied before fn runs)
//
// Built to out/sdk/panel.js by the main build (electron.vite.config.ts) and served by the
// cc-plugin:// handler for every plugin (src/main/plugins/plugin-protocol.ts). It is a classic
// script, not a module: no import or export may appear here (the main build emits CommonJS, and an
// `exports` reference would throw in a page); the logic lives in panel-core.ts and is bundled in.
// A `?raw` import: Vite inlines the file's text as a string literal, so this stays one classic
// script with no shared chunk (and no `require`) in out/sdk/panel.js.
import componentsCss from './components.css?raw'
import { PanelClient, sdkSheetsFirst, type PortLike } from './panel-core'

// The SDK's stylesheets are constructable ones: not inline <style>s, and the plugin CSP's
// style-src ('unsafe-inline') allows them anyway, so no CSP change. Missing support: no base styles.
// In install order (components at once, the scrollbars on the first theme), all before the page's
// own adopted sheets. The components are in `@layer cc`, so any unlayered page rule beats them;
// the scrollbar rule is zero-specificity, so a page's own sheet wins on it as well.
const sdkSheets: CSSStyleSheet[] = []
const client = new PanelClient(
  document.documentElement.style,
  (m) => console.warn(`ccPanel: ${m}`),
  {
    install(css) {
      const sheet = new CSSStyleSheet()
      sheet.replaceSync(css)
      sdkSheets.push(sheet)
      document.adoptedStyleSheets = sdkSheetsFirst(sdkSheets, document.adoptedStyleSheets)
    }
  },
  componentsCss
)

window.addEventListener('message', (event: MessageEvent) => {
  // Only the shell, which embeds this page, hands out ports and themes. The page's own scripts
  // post with their own window as source, and a sandboxed page cannot frame anything (CSP).
  if (event.source !== window.parent || window.parent === window) return
  client.receive(event.data, event.ports as readonly MessagePort[] as readonly PortLike[])
})

Object.defineProperty(window, 'ccPanel', { value: client.api, enumerable: true })
