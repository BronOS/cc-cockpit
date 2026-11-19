// ctx.rooms on the host side (design-rooms.md §4): each method is one RPC to main with this plugin's own id and plain
// data, only the documented fields; a bad argument fails at the call site with no round trip, and a deactivated
// plugin's call rejects. Main's side (the owner, the checks, the open budget) is in host-api.test.ts.
import { describe, expect, it } from 'vitest'
import { createRoomsApi } from '../../src/host/ctx/rooms'

function harness(answer: unknown = null): {
  rooms: ReturnType<typeof createRoomsApi>
  calls: { method: string; params: unknown }[]
  kill: () => void
} {
  const calls: { method: string; params: unknown }[] = []
  let dead = false
  const rooms = createRoomsApi({
    pluginId: 'example.team',
    call: async (method, params) => {
      calls.push({ method, params })
      return answer
    },
    guardAsync: <T>(body: () => Promise<T>): Promise<T> => {
      try {
        if (dead) throw new Error('the plugin is deactivated')
        return body()
      } catch (err) {
        return Promise.reject(err as Error)
      }
    }
  })
  return { rooms, calls, kill: () => (dead = true) }
}

describe('ctx.rooms (host side)', () => {
  it('forwards each call to main with the plugin id and only the fields given', async () => {
    const { rooms, calls } = harness()
    await rooms.create({ title: 'Review' })
    await rooms.list()
    await rooms.end('r1')
    await rooms.delete('r1')
    await rooms.open('r1', { name: 'lead', coordinator: true, prompt: 'go', model: 'sonnet', effort: 'high', cwd: 'sub' })
    await rooms.open('r1', { name: 'bob' })
    await rooms.invite('r1', { name: 'helper' })
    await rooms.invite('r1', { name: 'helper', coordinator: false })
    await rooms.members('r1')
    await rooms.remove('r1', 'bob')
    await rooms.send('r1', 'all', 'hello')
    await rooms.docs.list('r1')
    await rooms.docs.get('r1', 'shared/a.md')
    await rooms.docs.put('r1', 'shared/a.md', 'text')
    await rooms.log('r1')
    await rooms.log('r1', { since: 5, limit: 10 })
    const p = { pluginId: 'example.team' }
    expect(calls).toEqual([
      { method: 'rooms.create', params: { ...p, title: 'Review' } },
      { method: 'rooms.list', params: p },
      { method: 'rooms.end', params: { ...p, id: 'r1' } },
      { method: 'rooms.delete', params: { ...p, id: 'r1' } },
      {
        method: 'rooms.open',
        params: { ...p, id: 'r1', name: 'lead', coordinator: true, prompt: 'go', model: 'sonnet', effort: 'high', cwd: 'sub' }
      },
      { method: 'rooms.open', params: { ...p, id: 'r1', name: 'bob' } },
      { method: 'rooms.invite', params: { ...p, id: 'r1', name: 'helper' } },
      { method: 'rooms.invite', params: { ...p, id: 'r1', name: 'helper', coordinator: false } },
      { method: 'rooms.members', params: { ...p, id: 'r1' } },
      { method: 'rooms.remove', params: { ...p, id: 'r1', name: 'bob' } },
      { method: 'rooms.send', params: { ...p, id: 'r1', to: 'all', text: 'hello' } },
      { method: 'rooms.docs.list', params: { ...p, id: 'r1' } },
      { method: 'rooms.docs.get', params: { ...p, id: 'r1', path: 'shared/a.md' } },
      { method: 'rooms.docs.put', params: { ...p, id: 'r1', path: 'shared/a.md', text: 'text' } },
      { method: 'rooms.log', params: { ...p, id: 'r1' } },
      { method: 'rooms.log', params: { ...p, id: 'r1', since: 5, limit: 10 } }
    ])
  })

  it('never sends a field it does not document, nor a pluginId the caller passes', async () => {
    const { rooms, calls } = harness()
    await rooms.open('r1', { name: 'bob', focus: true, pluginId: 'other.plugin' } as never)
    await rooms.create({ title: 'x', pluginId: 'other.plugin' } as never)
    expect(calls).toEqual([
      { method: 'rooms.open', params: { pluginId: 'example.team', id: 'r1', name: 'bob' } },
      { method: 'rooms.create', params: { pluginId: 'example.team', title: 'x' } }
    ])
  })

  it('sends an allowed env as sessions.open does, with its fast errors', async () => {
    const CODE_MODE = 'CLAUDE_CODE_EXPERIMENTAL_CODE_MODE'
    const { rooms, calls } = harness()
    await rooms.open('r1', { name: 'bob', env: { [CODE_MODE]: '1' } })
    expect(calls).toEqual([{ method: 'rooms.open', params: { pluginId: 'example.team', id: 'r1', name: 'bob', env: { [CODE_MODE]: '1' } } }])
    await expect(rooms.open('r1', { name: 'b', env: { LD_PRELOAD: '/x.so' } })).rejects.toThrow('rooms.open: env: LD_PRELOAD is not allowed')
    await expect(rooms.open('r1', { name: 'b', env: [] as never })).rejects.toThrow('rooms.open: env must be an object')
    expect(calls).toHaveLength(1)
  })

  it('sends beside and side as sessions.open does, with its fast errors', async () => {
    const { rooms, calls } = harness()
    await rooms.open('r1', { name: 'bob', beside: 't1', side: 'down' })
    expect(calls).toEqual([{ method: 'rooms.open', params: { pluginId: 'example.team', id: 'r1', name: 'bob', beside: 't1', side: 'down' } }])
    await expect(rooms.open('r1', { name: 'b', side: 'down' })).rejects.toThrow('rooms.open: side needs beside')
    await expect(rooms.open('r1', { name: 'b', beside: '' })).rejects.toThrow('rooms.open: beside must be a tab id')
    await expect(rooms.open('r1', { name: 'b', beside: 't1', side: 'left' } as never)).rejects.toThrow("rooms.open: side must be 'right' or 'down'")
  })

  it('answers what main answered, and void for the calls that return nothing', async () => {
    const { rooms } = harness({ id: 'r1' })
    await expect(rooms.create({ title: 'x' })).resolves.toEqual({ id: 'r1' })
    await rooms.end('r1')
    await expect(rooms.docs.put('r1', 'shared/a', 'x')).resolves.toBeUndefined()
  })

  it('rejects a bad argument before any round trip', async () => {
    const { rooms, calls } = harness()
    await expect(rooms.create({ title: 5 } as never)).rejects.toThrow('rooms.create: title must be a string')
    await expect(rooms.create(undefined as never)).rejects.toThrow('rooms.create: title must be a string')
    await expect(rooms.end(5 as never)).rejects.toThrow('rooms.end: id must be a string')
    await expect(rooms.open('r1', {} as never)).rejects.toThrow('rooms.open: name must be a string')
    await expect(rooms.open('r1', { name: 'b', coordinator: 'yes' } as never)).rejects.toThrow('rooms.open: coordinator must be a boolean')
    await expect(rooms.open('r1', { name: 'b', model: 4 } as never)).rejects.toThrow('rooms.open: model must be a string')
    await expect(rooms.open('r1', 'bob' as never)).rejects.toThrow('rooms.open: options must be an object')
    await expect(rooms.send('r1', 'all', 5 as never)).rejects.toThrow('rooms.send: text must be a string')
    await expect(rooms.docs.get('r1', undefined as never)).rejects.toThrow('rooms.docs.get: path must be a string')
    await expect(rooms.log('r1', { since: Number.NaN })).rejects.toThrow('rooms.log: since must be a finite number')
    expect(calls).toEqual([])
  })

  it('rejects every call once the plugin is deactivated, and is frozen', async () => {
    const { rooms, calls, kill } = harness()
    kill()
    await expect(rooms.list()).rejects.toThrow('deactivated')
    await expect(rooms.docs.list('r1')).rejects.toThrow('deactivated')
    expect(calls).toEqual([])
    expect(Object.isFrozen(rooms)).toBe(true)
    expect(Object.isFrozen(rooms.docs)).toBe(true)
  })
})
