/* global document, ccPanel */
// Runs before <body> is parsed: results are written once the DOM is there.
const show = (id, text) => {
  const write = () => {
    document.getElementById(id).textContent = text
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', write)
  else write()
}
// The CSP's own report: the network fetch below must be refused by connect-src, not by the network.
document.addEventListener('securitypolicyviolation', (e) => {
  if (e.blockedURI.startsWith('https://example.com')) show('csp', `${e.effectiveDirective} ${e.blockedURI}`)
})
ccPanel.onMessage((message) => show('reply', JSON.stringify(message)))
// Posted before the port has arrived: the SDK queues it.
ccPanel.post({ ping: 1 })
fetch('data.json')
  .then((r) => r.json())
  .then(
    (j) => show('own', `own ${j.ok}`),
    (err) => show('own', `own failed ${err}`)
  )
fetch('https://example.com/').then(
  () => show('net', 'net loaded'),
  () => show('net', 'net blocked')
)
