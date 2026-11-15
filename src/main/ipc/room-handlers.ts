// The room channels of a project window's shell page (design-rooms.md §2 "The mark", §5 "The room view"): the person's
// acts on a member tab (the strip's mark and held badge) and on a room (the room view). Apart from router.ts so the
// rooms' rules sit together; each register function takes only the deps its channels use, wired in index.ts.
import type { DeliverHeldAnswer, TabRoomRef } from '../../shared/tab-room'
import { MAX_ID_CHARS } from '../../shared/room-names'
import type { RoomView } from '../../shared/room-view'
import { fields, tabIdOf, type CallView, type IpcRouter } from './router'

/**
 * What the tab strip's room parts need from main (design-rooms.md §2 "The mark", §5): the person's acts on a member tab
 * of the sender's own project. Wired in index.ts and nowhere else; host-api, hooks and the socket have no path to them
 * (no-plugin-room-mark.test.ts).
 */
export interface RoomStripHandlerDeps {
  /** Server mode: a browser view counts as the person (the approvals rule); outside it a browser is refused. */
  server: boolean
  /**
   * The tab's stored membership and mark (TabManager.roomOf): undefined for a tab of another project or in no room.
   * Checked against the request's `room` (the membership the person acted on) before anything is done.
   */
  membershipOf(projectId: string, tabId: string): { id: string; name: string; mark: boolean } | undefined
  /** TabManager.setRoomMark (throws for a tab of another project or in no room): the mark as stored. */
  roomMark(projectId: string, tabId: string, mark: boolean): boolean
  /** The mark went from off to on (RoomService.markTurnedOn): what waits is offered again. */
  markTurnedOn(projectId: string, tabId: string): void
  /**
   * The badge's click on a tab of `projectId`: the pointer, or why not (RoomService.deliverHeld). `overDraft` is the
   * person's "Deliver anyway" after a `draft` answer.
   */
  deliverHeld(projectId: string, tabId: string, overDraft: boolean): DeliverHeldAnswer
}

/**
 * `tabs.roomMark` and `rooms.deliverHeld`: only from the shell page's top frame of the tab's own project window
 * (handleProject), the tab id looked up inside that project. Both are `adapted`: a mark lets room text into a tab the
 * person typed in, and the badge pastes into it, so a browser view counts only in server mode, where the browsers are
 * the person (decided by the view main bound, never the payload). Nothing is announced here: TabManager.setRoomMark
 * already tells every view (`tabs.added`), and a delivery changes the sessions snapshot. What waits is offered again
 * only when the mark goes from off to on: clearing it, or setting it again, delivers nothing.
 *
 * Both carry the membership the strip showed (`room`): a request that waited (a slow view, a busy main) while the tab
 * left room A and joined room B must not mark B or paste B's pointer, since the person acted on A (design-rooms.md §2:
 * the mark is bound to (tab, room)). Main's own lookup decides; the payload only makes a stale request fail. The
 * check and the act run in one synchronous turn, so nothing changes the membership in between.
 */
export function registerRoomStripHandlers(router: IpcRouter, deps: RoomStripHandlerDeps): void {
  router.handleProject('tabs.roomMark', (ctx, payload, view) => {
    personOnly(deps.server, 'tabs.roomMark', view)
    const mark = fields('tabs.roomMark', payload).mark
    if (typeof mark !== 'boolean') throw new Error('tabs.roomMark: mark must be true or false')
    const tabId = tabIdOf('tabs.roomMark', payload)
    const expected = roomRefOf('tabs.roomMark', payload)
    const current = deps.membershipOf(ctx.projectId, tabId)
    if (current === undefined) throw new Error('tabs.roomMark: the tab is in no room')
    if (!sameRoom(current, expected)) throw new Error('tabs.roomMark: the tab is no longer in that room (stale request)')
    const was = current.mark
    const stored = deps.roomMark(ctx.projectId, tabId, mark)
    if (stored && !was) deps.markTurnedOn(ctx.projectId, tabId)
    return stored
  })
  router.handleProject('rooms.deliverHeld', (ctx, payload, view) => {
    personOnly(deps.server, 'rooms.deliverHeld', view)
    const overDraft = fields('rooms.deliverHeld', payload).overDraft
    if (overDraft !== undefined && overDraft !== true) throw new Error('rooms.deliverHeld: overDraft must be true or absent')
    const tabId = tabIdOf('rooms.deliverHeld', payload)
    const expected = roomRefOf('rooms.deliverHeld', payload)
    // Gone or moved since the badge was drawn: the badge's room is the one the person meant, so nothing goes in.
    const current = deps.membershipOf(ctx.projectId, tabId)
    if (current === undefined || !sameRoom(current, expected)) return { delivered: false, why: 'no-room' }
    return deps.deliverHeld(ctx.projectId, tabId, overDraft === true)
  })
}

/** The membership a request was made against (`room: { id, name }`): plain strings of a sane length, compared only. */
function roomRefOf(channel: string, payload: unknown): TabRoomRef {
  const room = fields(channel, payload).room
  if (typeof room !== 'object' || room === null || Array.isArray(room)) throw new Error(`${channel}: room must be { id, name }`)
  const { id, name } = room as Record<string, unknown>
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID_CHARS) throw new Error(`${channel}: room.id must be a room id`)
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_ID_CHARS) throw new Error(`${channel}: room.name must be a member name`)
  return { id, name }
}

/** The tab's current membership is the one the request was made against. */
function sameRoom(current: TabRoomRef, expected: TabRoomRef): boolean {
  return current.id === expected.id && current.name === expected.name
}

/**
 * The person's acts on a room (`adapted` channels): a browser view counts as the person only in server mode, where the
 * browsers are the person (the approvals rule); decided by the view main bound, never the payload.
 */
function personOnly(server: boolean, channel: string, view: CallView): void {
  if (view.remote && !server) throw new Error(`${channel}: refused for a browser view outside server mode`)
}

/**
 * A room id from a payload: a string of a sane length (the room service looks it up in the sender's project). Only the
 * length here, not isRoomId's shape: an id of the wrong shape is the service's "no such room", like a foreign one.
 */
function roomIdOf(channel: string, payload: unknown): string {
  const roomId = fields(channel, payload).roomId
  if (typeof roomId !== 'string' || roomId.length === 0 || roomId.length > MAX_ID_CHARS) throw new Error(`${channel}: roomId must be a room id`)
  return roomId
}

/** A required string field of a payload (its content is the room service's to check). */
function stringField(channel: string, payload: unknown, key: string): string {
  const value = fields(channel, payload)[key]
  if (typeof value !== 'string') throw new Error(`${channel}: ${key} must be a string`)
  return value
}

/**
 * What the room view's channels need from main (design-rooms.md §5, room-service.ts "the room view"). Every call takes
 * the sender's project (main's) and looks the room up there: another project's room is "no such room".
 */
export interface RoomViewHandlerDeps {
  /** Server mode: a browser view counts as the person; outside it a browser may read but not act. */
  server: boolean
  view(projectId: string, roomId: string): Promise<RoomView>
  doc(projectId: string, roomId: string, path: string): Promise<string>
  pause(projectId: string, roomId: string): void
  resume(projectId: string, roomId: string): void
  /** The member a Remove names, checked (throws "no such room" / "no such member"): the ask's words. */
  removeTarget(projectId: string, roomId: string, name: string): { roomId: string; title: string; name: string }
  remove(projectId: string, roomId: string, name: string): void
  /**
   * Put the Remove confirm to every view of `windowId` (SharedAsks: first answer wins, a timeout or no view is a
   * decline): true only when a view answered Remove.
   */
  askRemove(windowId: number, info: { roomId: string; title: string; name: string }): Promise<boolean>
  /** A view's answer to that ask, for the sender's own window (SharedAsks.answer). */
  removeAnswer(windowId: number, requestId: string, remove: boolean): boolean
  /** Show the room's folder in the host's file manager (RoomService.revealFolder, then the shell adapter). */
  reveal(projectId: string, roomId: string): Promise<void>
}

/**
 * The room view's channels, all from the shell page's top frame of a project window (handleProject), for that
 * project's rooms only. `rooms.view` and `rooms.doc` are reads (`yes`: a browser may read, message text included).
 * Pause, Resume, Remove and the Remove answer are the person's acts (`adapted`): a browser counts only in server mode.
 * A Remove from a server's browser is not done on the click: main asks every view of the window first (an
 * ApprovalDialog, `rooms.removeAsk`), and removes only on a Remove answer, checking the member again then (it may have
 * left while the dialog was up). The desktop's Remove is done at once (its dialog confirms on its own screen). Reveal
 * is `no` (the router refuses a browser before this runs) and refused in server mode too: there the host has no
 * screen (design-web.md §9.9, as ctx.files.reveal).
 */
export function registerRoomViewHandlers(router: IpcRouter, deps: RoomViewHandlerDeps): void {
  router.handleProject('rooms.view', (ctx, payload) => deps.view(ctx.projectId, roomIdOf('rooms.view', payload)))

  router.handleProject('rooms.doc', (ctx, payload) => {
    const path = stringField('rooms.doc', payload, 'path')
    return deps.doc(ctx.projectId, roomIdOf('rooms.doc', payload), path)
  })

  router.handleProject('rooms.pause', (ctx, payload, view) => {
    personOnly(deps.server, 'rooms.pause', view)
    deps.pause(ctx.projectId, roomIdOf('rooms.pause', payload))
  })

  router.handleProject('rooms.resume', (ctx, payload, view) => {
    personOnly(deps.server, 'rooms.resume', view)
    deps.resume(ctx.projectId, roomIdOf('rooms.resume', payload))
  })

  router.handleProject('rooms.remove', async (ctx, payload, view) => {
    personOnly(deps.server, 'rooms.remove', view)
    const roomId = roomIdOf('rooms.remove', payload)
    const name = stringField('rooms.remove', payload, 'name')
    const target = deps.removeTarget(ctx.projectId, roomId, name)
    if (view.remote && !(await deps.askRemove(ctx.windowId, target))) return { removed: false }
    deps.remove(ctx.projectId, roomId, name)
    return { removed: true }
  })

  router.handleProject('rooms.removeAnswer', (ctx, payload, view) => {
    personOnly(deps.server, 'rooms.removeAnswer', view)
    const requestId = stringField('rooms.removeAnswer', payload, 'requestId')
    const remove = fields('rooms.removeAnswer', payload).remove
    if (typeof remove !== 'boolean') throw new Error('rooms.removeAnswer: remove must be a boolean')
    return deps.removeAnswer(ctx.windowId, requestId, remove)
  })

  router.handleProject('rooms.reveal', (ctx, payload, view) => {
    if (view.remote) throw new Error('rooms.reveal: refused for a browser view')
    if (deps.server) throw new Error('rooms.reveal: refused in server mode (the host has no screen)')
    return deps.reveal(ctx.projectId, roomIdOf('rooms.reveal', payload))
  })
}
