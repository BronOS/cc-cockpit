/* global document, ccPanel */
const ready = (fn) => (document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', fn) : fn())
ccPanel.onMessage((m) => ready(() => (document.getElementById('subject').textContent = m.subject)))
ccPanel.post({ hello: 1 })
