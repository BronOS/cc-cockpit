---
worth: yes
where: src/main/webview/webview-hardening.ts:211
added: 2026-11-12
---
# off-screen pages: print and file choosers not cancelled in cross-site iframes

`cancelOffscreenNativeUi` attaches the DevTools protocol to the page's main target only, so
`Page.setInterceptFileChooserDialog {cancel}` and the locked no-op `print` reach the main frame and its
same-process frames, but not a cross-site iframe (another renderer process). With a desktop portal on the
server's session bus such a frame can still open the portal's Print dialog or file chooser on the host's
desktop and block its own renderer until someone answers. `Document.prototype.execCommand('print')` is
another path to the print dialog the `window.print` lock does not cover, in every frame. Found in the
security review of the streamed webviews (server mode).

Suggested fix: `Target.setAutoAttach { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }`,
then for each attached child session send the same three commands (`Page.enable`,
`Page.setInterceptFileChooserDialog`, `Page.addScriptToEvaluateOnNewDocument`) with its `sessionId` and
`Runtime.runIfWaitingForDebugger`; extend the injected source to wrap `execCommand` and refuse `'print'`.
Needs a headless spike with a portal on the bus to prove the child sessions take the cancels.
