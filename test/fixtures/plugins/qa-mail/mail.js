/* global document, ccPanel */
ccPanel.onMessage((m) => {
  if (m && typeof m.text === 'string') document.getElementById('body').textContent = m.text
})
