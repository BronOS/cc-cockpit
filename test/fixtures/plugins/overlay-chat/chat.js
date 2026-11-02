/* global document, ccPanel */
// Lists every message from the host; answers the hello and each ack below 3 with the next { n },
// then enables Done, whose { result } closes the overlay.
const log = document.getElementById('log')
const done = document.getElementById('done')
let n = 0
ccPanel.onMessage((message) => {
  const item = document.createElement('li')
  item.textContent = JSON.stringify(message)
  log.appendChild(item)
  if (message.hello || (typeof message.ack === 'number' && message.ack < 3)) {
    n += 1
    ccPanel.post({ n })
  }
  if (message.ack === 3) done.disabled = false
})
done.addEventListener('click', () => ccPanel.post({ result: { exchanged: n } }))
