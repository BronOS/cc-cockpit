/* global document, ccPanel */
// The panel page: shows what the host posts and sends clicks back. textContent, never innerHTML:
// the greeting comes from a setting, and a real plugin's text comes from places you don't control.
const $ = (id) => document.getElementById(id)

ccPanel.onMessage((message) => {
  if (!message || message.type !== 'state') return
  $('greeting').textContent = message.greeting
  $('clicks').textContent = String(message.clicks)
})

document.addEventListener('DOMContentLoaded', () => {
  $('click').addEventListener('click', () => ccPanel.post({ type: 'click' }))
  $('reset').addEventListener('click', () => ccPanel.post({ type: 'reset' }))
  // Ask for the current state: anything posted while this page was not shown was dropped.
  ccPanel.post({ type: 'ready' })
})
