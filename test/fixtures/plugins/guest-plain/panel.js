/* global document, ccPanel */
const ready = (fn) => (document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', fn) : fn())
ccPanel.onMessage((m) => ready(() => (document.getElementById('count').textContent = `count ${m.count}`)))
ccPanel.post({ hello: 1 })
ready(() => document.getElementById('bump').addEventListener('click', () => ccPanel.post({ bump: 1 })))
