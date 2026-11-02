/* global document, ccPanel */
// The panel side of the hello plugin: renders the state the host posts and sends the user's
// clicks back. Everything goes through textContent, never innerHTML: the text it shows (a git
// path, a session's last prompt) is not under this page's control.
const $ = (id) => document.getElementById(id)

function render(state) {
  $('greeting').textContent = state.greeting
  $('visits').textContent = String(state.visits)
  $('ticks').textContent = String(state.ticks)

  // Keep the chosen session across re-renders (the host posts the whole state on every change).
  const select = $('sessions')
  const chosen = select.value
  select.replaceChildren(
    ...state.sessions.map((s) => {
      const option = document.createElement('option')
      option.value = s.tabId
      option.textContent = `${s.status}: ${s.lastPrompt || s.tabId}`
      return option
    })
  )
  if (state.sessions.some((s) => s.tabId === chosen)) select.value = chosen
  $('send').disabled = state.sessions.length === 0

  // Only whether the secret setting has a value: the host never sends the value itself.
  $('token-state').textContent = state.tokenSet ? 'set' : 'not set'
  $('bumps').textContent = state.bumps === null ? 'not set' : String(state.bumps)
  $('secret-keys').textContent = state.secretKeys.length > 0 ? state.secretKeys.join(', ') : '(none)'
  $('secret-error').textContent = state.secretError

  $('send-result').textContent = state.lastSend
  $('git').textContent = !state.git
    ? '...'
    : state.git.error !== undefined
      ? `(${state.git.error})`
      : state.git.lines.length > 0
        ? state.git.lines.join('\n')
        : '(clean)'
  $('overlay-result').textContent = state.lastOverlay
}

ccPanel.onMessage((message) => {
  if (message && message.type === 'state') render(message)
})

document.addEventListener('DOMContentLoaded', () => {
  $('send').addEventListener('click', () => {
    const text = $('text').value
    if (!$('sessions').value || !text) return
    ccPanel.post({ type: 'send', tabId: $('sessions').value, text })
    $('text').value = ''
  })
  $('git-refresh').addEventListener('click', () => ccPanel.post({ type: 'git' }))
  $('term-overlay').addEventListener('click', () => ccPanel.post({ type: 'overlay', kind: 'terminal' }))
  $('html-overlay').addEventListener('click', () => ccPanel.post({ type: 'overlay', kind: 'html' }))
  $('bump').addEventListener('click', () => ccPanel.post({ type: 'bump' }))
  $('forget-bumps').addEventListener('click', () => ccPanel.post({ type: 'forget-bumps' }))
  $('reset').addEventListener('click', () => ccPanel.post({ type: 'reset' }))
})

// The host drops messages while this panel is closed, so ask for the current state on load (the
// SDK queues the post until its port to the host has arrived).
ccPanel.post({ type: 'ready' })
