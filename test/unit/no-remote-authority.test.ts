import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Guests (design-guests §4, task 03 acceptance 1): `view.remote` only says a call came over the gateway. With
// guests a remote view is not the owner, so an authority decision reads `isOwner(view)`; `view.remote` may still
// shape transport (a reply, an ack, a size, the hidden page). Every code line in the router files naming
// `.remote` must either check `isOwner(` on the same line or be one of the transport lines below, each with why.
// A new `.remote` line fails here until it is one or the other.

const ROOT = join(__dirname, '..', '..')

const TRANSPORT: Record<string, Record<string, string>> = {
  'src/main/ipc/router.ts': {
    'if (!view.remote) return': "theme.scheme: a browser view's own colour scheme; the desktop has none to report",
    'const hiddenPage = (view: CallView): boolean => deps.server && !view.remote': "server mode's hidden page (nobody looks at it)",
    'if (!view.remote) return undefined': 'web access: the acting device of a remote view (actorOf), for the log',
    'if (view.remote) {': 'web access card shaped for a browser; tabs.list plain list (guests filtered inside)',
    'return view.remote ? remoteIndicator(deps.indicator()) : deps.indicator()': 'indicator shaped for a browser',
    "if (ctx.kind !== 'picker' || view.remote) throw new Error(`${channel}: only the project picker may use remote servers`)":
      'remote servers: the desktop picker only (a guest is always remote, so refused)',
    'if (view.remote) tabs.viewAck(view.viewId, tabId, count)': "a browser's own flow-control ack",
    "if (view.remote) throw new Error('tabs.screen: refused')": 'tabs.screen is the desktop page only (a guest is always remote)',
    'if (view.remote) tabs.viewSelect(view.viewId, tabId)': "a browser's own selected tab (terminal join)",
    "if (view.remote && !deps.server) throw new Error(`${channel}: only the desktop page may widen a guest's access`)":
      'D-11 widening helper; its handlers check isOwner first (owner())',
    'return deps.linkAnswer(ctx.windowId, requestId, allow, view.remote)': 'links.answer: after its isOwner check, remote may only Deny on a desktop',
    'if (!view.remote || !deps.downloadAccept) return false': 'downloads.accept: only a browser downloads; guests checked by the ask target (D-23)',
    'const view = callView.remote ? deps.set(ctx.projectId, layout, { keepGeometry: true }) : deps.set(ctx.projectId, layout)':
      "layout.set keepGeometry: a browser never moves the desktop's window geometry",
    'if (view.remote) return': "overlays.ack: only the desktop's acks are flow control",
    "if (view.remote && deps.server !== true) throw new Error(`${channel}: only a browser view of a server has a webview toolbar`)":
      'webview toolbar: a browser outside server mode has a placeholder, no page',
    'if (deps.server !== true || !view.remote || !deps.viewers) {': 'webview viewers: browsers of a server (guest roles go to WebviewViewers)',
    'if (deps.server !== true || !view.remote || !deps.input) {': 'webview input: browsers of a server (GUEST_CLASS write, visible plugin)',
    'return view.remote ? view.viewId : undefined': "remoteViewOf: an origin-view hint, never authority (D-27)"
  },
  'src/main/ipc/room-handlers.ts': {
    'if (view.remote && !(await deps.askRemove(ctx.windowId, target))) return { removed: false }':
      'rooms.remove: a browser owner confirms; personOnly (isOwner) ran first'
  }
}

function remoteLines(path: string): string[] {
  return readFileSync(join(ROOT, path), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /\b\w+\.remote\b/.test(line) && !/^(\/\/|\*|\/\*)/.test(line))
}

describe('authority reads isOwner, view.remote only shapes transport', () => {
  for (const [path, allowed] of Object.entries(TRANSPORT)) {
    it(`${path}: every .remote line checks isOwner or is a listed transport site`, () => {
      const lines = remoteLines(path)
      expect(lines.filter((line) => !line.includes('isOwner(') && !Object.hasOwn(allowed, line))).toEqual([])
    })

    it(`${path}: no stale entry in the transport list`, () => {
      const lines = new Set(remoteLines(path))
      expect(Object.keys(allowed).filter((line) => !lines.has(line))).toEqual([])
    })
  }
})
