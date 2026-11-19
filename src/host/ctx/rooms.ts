// ctx.rooms (design-rooms.md §4): the plugin's rooms of Claude tabs. Nothing is kept here: a room spans tabs main
// owns, its members' identities are main's, and every rule (the owner, the names, the caps, the docs' areas) is
// decided there (src/main/plugins/host-api.ts roomsCall, src/main/rooms/room-service.ts). Each method is one RPC
// carrying this plugin's own id and plain data; the type checks here only give a bad call a fast error at its call
// site, and main checks everything again. No events: a plugin that follows a room polls `log` with the `since` cursor (a `seq`).
import type { OpenBeside, OpenedTab, PluginContext, RoomDoc, RoomInfo, RoomLogPage, RoomMember, RoomSendAnswer } from '../../sdk/types'
import { besideOf } from './sessions'

export interface RoomsApiDeps {
  pluginId: string
  call(method: string, params: unknown): Promise<unknown>
  /** Rejects once the plugin is deactivated, and turns a synchronous throw into a rejection. */
  guardAsync<T>(body: () => Promise<T>): Promise<T>
}

type Rooms = PluginContext['rooms']

function text(value: unknown, what: string, field: string): string {
  if (typeof value !== 'string') throw new TypeError(`${what}: ${field} must be a string`)
  return value
}

function optionalBoolean(value: unknown, what: string, field: string): boolean | undefined {
  if (value !== undefined && typeof value !== 'boolean') throw new TypeError(`${what}: ${field} must be a boolean`)
  return value as boolean | undefined
}

function optionalString(value: unknown, what: string, field: string): string | undefined {
  if (value !== undefined && typeof value !== 'string') throw new TypeError(`${what}: ${field} must be a string`)
  return value as string | undefined
}

function optionalNumber(value: unknown, what: string, field: string): number | undefined {
  if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
    throw new TypeError(`${what}: ${field} must be a finite number`)
  }
  return value as number | undefined
}

function options(value: unknown, what: string): Record<string, unknown> {
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${what}: options must be an object`)
  return value as Record<string, unknown>
}

/** Only the fields given: an absent option is not sent as `undefined`. */
function defined(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined))
}

export function createRoomsApi(deps: RoomsApiDeps): Rooms {
  const { pluginId, call, guardAsync } = deps
  // `pluginId` is this plugin's own; main refuses an id its host does not run and builds the owner itself.
  // Every method runs it inside guardAsync: a deactivated plugin's call rejects, and so does a bad argument.
  const ask = async <T>(method: string, params: Record<string, unknown>): Promise<T> => (await call(method, { pluginId, ...params })) as T

  const docs: Rooms['docs'] = Object.freeze({
    list: (id: string) => guardAsync(() => ask<RoomDoc[]>('rooms.docs.list', { id: text(id, 'rooms.docs.list', 'id') })),
    get: (id: string, path: string) =>
      guardAsync(() =>
        ask<string>('rooms.docs.get', { id: text(id, 'rooms.docs.get', 'id'), path: text(path, 'rooms.docs.get', 'path') })
      ),
    put: (id: string, path: string, body: string) =>
      guardAsync(async () => {
        await ask<null>('rooms.docs.put', {
          id: text(id, 'rooms.docs.put', 'id'),
          path: text(path, 'rooms.docs.put', 'path'),
          text: text(body, 'rooms.docs.put', 'text')
        })
      })
  })

  const api: Rooms = {
    create: (opts: { title: string }) =>
      guardAsync(() => ask<{ id: string }>('rooms.create', { title: text(options(opts, 'rooms.create').title, 'rooms.create', 'title') })),
    list: () => guardAsync(() => ask<RoomInfo[]>('rooms.list', {})),
    end: (id: string, opts?: { closeTabs?: boolean }) =>
      guardAsync(() =>
        ask<{ closed: number }>('rooms.end', {
          id: text(id, 'rooms.end', 'id'),
          ...(opts?.closeTabs === undefined ? {} : { closeTabs: opts.closeTabs })
        })
      ),
    delete: (id: string) =>
      guardAsync(async () => {
        await ask<null>('rooms.delete', { id: text(id, 'rooms.delete', 'id') })
      }),
    open: (id: string, opts: { name: string; coordinator?: boolean; prompt?: string; model?: string; effort?: string; cwd?: string } & OpenBeside) =>
      guardAsync(() => {
        const w = 'rooms.open'
        const o = options(opts, w)
        // Only the documented options go to main (no focus): the tab opens unselected, a split pane when `beside`.
        return ask<OpenedTab>(w, {
          id: text(id, w, 'id'),
          ...defined({
            name: text(o.name, w, 'name'),
            coordinator: optionalBoolean(o.coordinator, w, 'coordinator'),
            prompt: optionalString(o.prompt, w, 'prompt'),
            model: optionalString(o.model, w, 'model'),
            effort: optionalString(o.effort, w, 'effort'),
            cwd: optionalString(o.cwd, w, 'cwd')
          }),
          ...besideOf(w, o)
        })
      }),
    invite: (id: string, opts: { name: string; coordinator?: boolean }) =>
      guardAsync(() => {
        const w = 'rooms.invite'
        const o = options(opts, w)
        return ask<{ code: string; expiresAt: number }>(w, {
          id: text(id, w, 'id'),
          ...defined({ name: text(o.name, w, 'name'), coordinator: optionalBoolean(o.coordinator, w, 'coordinator') })
        })
      }),
    members: (id: string) => guardAsync(() => ask<RoomMember[]>('rooms.members', { id: text(id, 'rooms.members', 'id') })),
    remove: (id: string, name: string) =>
      guardAsync(async () => {
        await ask<null>('rooms.remove', { id: text(id, 'rooms.remove', 'id'), name: text(name, 'rooms.remove', 'name') })
      }),
    send: (id: string, to: string, body: string) =>
      guardAsync(() =>
        ask<RoomSendAnswer[]>('rooms.send', { id: text(id, 'rooms.send', 'id'), to: text(to, 'rooms.send', 'to'), text: text(body, 'rooms.send', 'text') })
      ),
    docs,
    log: (id: string, opts?: { since?: number; limit?: number }) =>
      guardAsync(() => {
        const w = 'rooms.log'
        const o = options(opts, w)
        return ask<RoomLogPage>(w, {
          id: text(id, w, 'id'),
          ...defined({ since: optionalNumber(o.since, w, 'since'), limit: optionalNumber(o.limit, w, 'limit') })
        })
      })
  }
  return Object.freeze(api)
}
