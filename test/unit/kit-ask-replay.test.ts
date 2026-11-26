// B2 (dev-frank's report, fixed in the page SDK): main pushes an Ask chat's `history` once, when the copy's port is up, but the
// overlay kit's mountAsk subscribes when the plugin draws, after its state came, so after that push. The page SDK keeps
// the last `history` and `state` and replays them to a late `ask.on` listener. Checked here through the real pair: the
// SDK's OverlayCopyClient (src/sdk/panel-overlay.ts) and the kit's own mountAsk (kit/src/ask.mjs) on the kit's fake
// document, with the push arriving before the mount.
import { describe, expect, it } from 'vitest'
import { OverlayCopyClient } from '../../src/sdk/panel-overlay'

// Plain JS modules with no types: imported by a computed path so the typecheck does not resolve them.
const KIT = '../../kit/src/index.mjs'
const FAKE_DOM = '../../kit/test/fake-dom.mjs'

interface FakeDom {
  FakeDocument: new () => { body: { appendChild(n: unknown): void }; createElement(tag: string): unknown }
  all(root: unknown): Iterable<{ textContent: string }>
  flush(): Promise<void>
}
interface Kit {
  mountAsk(container: unknown, opts: Record<string, unknown>): { el: { textContent: string } | null; destroy(): void }
}

const push = (client: OverlayCopyClient, seq: number, data: unknown): void => client.receive({ $cc: 1, ev: 'ask', seq, data })

function copyClient(): { client: OverlayCopyClient; sent: string[] } {
  const sent: string[] = []
  const client = new OverlayCopyClient(
    (text) => (sent.push(text), true),
    () => {},
    () => 'owner',
    1_000_000,
    50 // requests nothing answers (the kit's pick read) give up quickly
  )
  client.intro({ notes: true, ask: true, discuss: true })
  return { client, sent }
}

describe('a late Ask listener (the kit mounting after the history push)', () => {
  it("the kit's mountAsk, mounted after the history push, shows the stored chat", async () => {
    const kit = (await import(KIT)) as Kit
    const { FakeDocument, flush } = (await import(FAKE_DOM)) as FakeDom
    const { client } = copyClient()
    // The copy's port came up: main's history push (and a state) arrive before the plugin's state, so before the mount.
    push(client, 1, { type: 'history', turns: [{ question: 'what is the fox', answer: 'A quick brown one.' }], pick: { models: ['sonnet'], efforts: ['low'] } })
    push(client, 2, { type: 'state', phase: 'ready' })

    const doc = new FakeDocument()
    const root = doc.createElement('div')
    doc.body.appendChild(root)
    const ask = kit.mountAsk(root, { doc, panel: { ask: client.ask }, about: 'About: the doc', canContinue: true })
    await flush()
    await flush()
    expect(ask.el).not.toBeNull()
    expect(ask.el!.textContent).toContain('what is the fox')
    expect(ask.el!.textContent).toContain('A quick brown one.')
    ask.destroy()
  })

  it('a later push replaces what is replayed; deltas and answers are never replayed', async () => {
    const { client } = copyClient()
    push(client, 1, { type: 'history', turns: [{ question: 'old', answer: 'old answer' }], pick: { models: [], efforts: [] } })
    push(client, 2, { type: 'history', turns: [{ question: 'new', answer: 'new answer' }], pick: { models: [], efforts: [] } })
    push(client, 3, { type: 'delta', text: 'part' })
    push(client, 4, { type: 'answer', text: 'done' })
    const seen: Array<{ type: string; turns?: Array<{ question: string }> }> = []
    for (const type of ['history', 'delta', 'answer'] as const) client.ask!.on(type, (d) => seen.push(d as (typeof seen)[number]))
    await new Promise((r) => setTimeout(r, 0))
    expect(seen.map((d) => d.type)).toEqual(['history'])
    expect(seen[0]!.turns!.map((t) => t.question)).toEqual(['new'])
  })
})
