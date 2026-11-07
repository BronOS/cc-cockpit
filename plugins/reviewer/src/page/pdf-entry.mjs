// The PDF engine of the review page, bundled on its own into overlay/pdf.bundle.js (a classic
// script, like review.bundle.js) and loaded only when a PDF is shown, so a diff or a markdown file
// does not pay for 1.8 MB of pdf.js.
//
// pdf.js normally parses in a Worker. The page is a sandboxed frame with an opaque origin: a
// `new Worker(cc-plugin://…)` from it is a cross-origin worker and is refused, a blob: worker is
// outside the CSP (`script-src` self only), and pdf.js's own fallback (a dynamic import of the
// worker module) needs CORS on the scheme. So the worker's code is in this bundle and published as
// `globalThis.pdfjsWorker`: pdf.js then runs its "fake worker" on the page's thread with it, which
// needs no fetch and no worker. Parsing a large PDF holds the page for a moment; that is the cost.
import * as pdfjsLib from 'pdfjs-dist/build/pdf.mjs'
import { WorkerMessageHandler } from 'pdfjs-dist/build/pdf.worker.mjs'

globalThis.pdfjsWorker = { WorkerMessageHandler }
globalThis.pdfjsLib = pdfjsLib
