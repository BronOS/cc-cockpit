// The panel SDK as plugins load it: `<script src="../__sdk/panel.js"></script>` (relative to the page,
// one folder deep; it is served at the plugin's root) in a panel page or a plugin's html overlay page,
// then `window.ccPanel`:
//
//   ccPanel.post(message)                send JSON to the plugin's host (`ctx.panels.onMessage`);
//                                        in an html overlay, `post({ result: value })` closes the
//                                        overlay and `ctx.overlay.open` resolves with that value
//   ccPanel.onMessage(fn)                what the host sends (`ctx.panels.post`); returns unsubscribe
//   ccPanel.theme.current                { kind, vars }: the app theme, already applied to :root
//   ccPanel.theme.onChange(fn)           a new theme (applied before fn runs)
//   ccPanel.slot                         only when the page is drawn as a slot (contributes.slots):
//                                        { type, setHeight(px), setWidth(px) }; undefined in a panel
//                                        or an overlay (setWidth: the top bar's frame only)
//   ccPanel.onConnect(fn)                fn runs on every new connection to the plugin; a page tab
//                                        gets more than one (never reloaded for one): re-send there
//   ccPanel.tab                          only when the page is drawn as a page tab (contributes.tabs):
//                                        { type, setDirty(bool), discuss() } (setDirty: unsaved changes
//                                        in this view, the dirty dot and core's close ask, a report,
//                                        never a veto; discuss: opens Ask Claude about this tab, taken
//                                        only while the page is shown and has the keyboard)
//   ccPanel.ready()                      an html overlay's page has drawn: the app's loader goes
//                                        (needed with `ready: 'manual'`; harmless elsewhere)
//   ccPanel.view.remote                  the page is drawn in a web access browser view (the shell
//                                        says so with the port; false until then and on the desktop).
//                                        A UI hint only: main refuses desktop-only calls by itself
//   ccPanel.view.access                  who is behind this view: 'owner', or a guest's 'read' / 'write'
//                                        (the shell says so with the port; 'owner' until then). A UI
//                                        hint only: the plugin's host gets the access from main
//   ccPanel.upload                       web shell, not a read guest, once connected (else undefined):
//                                        { pick({folder}), files(source, {folder}) } hand files from the
//                                        person's device to core's upload flow (design-upload.md §5.2);
//                                        pick inside a click, files inside `drop`; a panel page's only
//
// Built to out/sdk/panel.js by a build of its own, IIFE output (panelSdk in electron.vite.config.ts,
// which fails the build if the file imports or requires anything), and served by the cc-plugin://
// handler for every plugin (src/main/plugins/plugin-protocol.ts). It is a classic script, not a
// module: no export may appear here; the logic lives in panel-core.ts and is bundled in.
// A `?raw` import: Vite inlines the file's text as a string literal, so this stays one classic
// script with no `require` in out/sdk/panel.js.
import componentsCss from './components.css?raw'
import { cancelsFilesDrag, PanelClient, sdkSheetsFirst, type PortLike } from './panel-core'
import { startScrollEdges, watchClassicBars } from './scroll-edges'

// The SDK's stylesheets are constructable ones: not inline <style>s, and the plugin CSP's
// style-src ('unsafe-inline') allows them anyway, so no CSP change. Missing support: no base styles.
// In install order (components and the scroll fade at once, the scrollbars on the first theme), all
// before the page's own adopted sheets. The components are in `@layer cc`, so any unlayered page rule
// beats them; the scroll sheets are in its sub-layer `cc.scroll` with zero-specificity selectors, so
// the components and the page's own sheets win on them as well.
const sdkSheets: CSSStyleSheet[] = []
const sheetOf = new Map<string, CSSStyleSheet>()
const client = new PanelClient(
  document.documentElement.style,
  (m) => console.warn(`ccPanel: ${m}`),
  {
    install(css) {
      const sheet = new CSSStyleSheet()
      sheet.replaceSync(css)
      sdkSheets.push(sheet)
      sheetOf.set(css, sheet)
      document.adoptedStyleSheets = sdkSheetsFirst(sdkSheets, document.adoptedStyleSheets)
    },
    enable(css, on) {
      const sheet = sheetOf.get(css)
      if (sheet) sheet.disabled = !on
    }
  },
  componentsCss,
  // Only the shell frames this page, and only the shell hears this: a height, a width, `ready`, or the
  // files of an upload (`File`s cross by structured clone).
  (message) => {
    if (window.parent !== window) window.parent.postMessage(message, '*')
  },
  // macOS: this page measures its own bars (classic or overlay) for the scrollbar sheet.
  (onChange) => watchClassicBars(window, onChange),
  // `ccPanel.upload.pick`: a hidden input, clicked now (the caller's gesture is what lets a browser open a
  // chooser). In the document while it is open (Safari opens none for a detached input), gone after the
  // choice or a cancel; an earlier one left by a browser with no `cancel` event goes at the next pick.
  (onFiles) => {
    document.querySelectorAll('input[data-cc-upload-picker]').forEach((old) => old.remove())
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.dataset['ccUploadPicker'] = ''
    input.style.display = 'none'
    input.addEventListener('change', () => {
      const files = Array.from(input.files ?? [])
      input.remove()
      onFiles(files)
    })
    input.addEventListener('cancel', () => input.remove())
    ;(document.body ?? document.documentElement).append(input)
    input.click()
  }
)

// A file dropped where the page takes no drop must not open in the frame (design-upload.md §3.6: in a
// plain browser that replaces the page). Bubble phase on the window, after the page's own handlers: a
// drag the page already took (`preventDefault` on its dragover / drop) is left alone, and so is one over a
// file input, a text field or a contenteditable (they take a drop by the browser's default, never
// cancelling dragover); any other `Files` drag is refused (`dropEffect` none: no drop, no copy cursor)
// and its drop cancelled. These listeners run before the page's own window-level ones (added first), so a
// window-level dragover handler must set `dropEffect` itself (the guide says so).
window.addEventListener('dragover', (event: DragEvent) => {
  if (!cancelsFilesDrag(event)) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'none'
})
window.addEventListener('drop', (event: DragEvent) => {
  if (cancelsFilesDrag(event)) event.preventDefault()
})

window.addEventListener('message', (event: MessageEvent) => {
  // Only the shell, which embeds this page, hands out ports and themes. The page's own scripts
  // post with their own window as source, and a sandboxed page cannot frame anything (CSP).
  if (event.source !== window.parent || window.parent === window) return
  client.receive(event.data, event.ports as readonly MessagePort[] as readonly PortLike[])
})

// A page tab in the web shell: the app's chords (Ctrl+Alt+W, Ctrl+Alt+Tab...) go to the shell, not the
// page (design-editor.md §1 "Keyboard"). Capture phase on the window, added before any page script
// runs, so the page's own handlers never see them. The desktop lists none: main takes them first.
window.addEventListener(
  'keydown',
  (event: KeyboardEvent) => {
    if (!client.keyDown(event)) return
    event.preventDefault()
    event.stopImmediatePropagation()
  },
  true
)

// A page tab's window got the keyboard: the shell is told, as it sees no event when the keyboard moves
// from frame to frame, and decides whether it may stay (design-split-pages.md §4). Before any page script.
window.addEventListener('focus', () => client.windowFocused())

// Edges-only scrolling (scroll-edges.ts): marks the page's scroll containers, the one scrolling and
// the one whose bar the pointer is near, for the sheets above.
startScrollEdges(window)

Object.defineProperty(window, 'ccPanel', { value: client.api, enumerable: true })
