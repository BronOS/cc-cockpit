/* global document, ccPanel */
// A module script: a static import of a sibling file, then a dynamic import() of another.
import { fromDep } from './dep.js'

const { fromLazy } = await import('./lazy.js')
document.getElementById('state').textContent = 'ran'
ccPanel.post({ result: { fromDep, fromLazy } })
