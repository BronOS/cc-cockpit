/* global document, ccPanel */
// The hello plugin's settings page. It has no settings API: it asks its backend for the note,
// shows it, and sends a save; the backend stores it (ctx.appStorage or ctx.storage per scope).
// textContent only, never innerHTML.
const $ = (id) => document.getElementById(id)

document.addEventListener('DOMContentLoaded', () => {
  ccPanel.onMessage((message) => {
    if (message.error) {
      $('status').textContent = `Error: ${message.error}`
      return
    }
    $('scope').textContent = message.scope
    $('note').value = message.note
    $('status').textContent = message.saved ? 'Saved' : ''
  })
  $('save').addEventListener('click', () => ccPanel.post({ type: 'save', note: $('note').value }))
  // Posts queue until the page's port arrives, so this reaches the backend once it is connected.
  ccPanel.post({ type: 'ready' })
})
