// The Remove ask of the room view (design-rooms.md §5): a server's browser asking to remove a member is put to every
// view of the window as a shared ask. Out of main/index.ts so a unit test drives the hooks (the `toWindow` channels)
// and the timeout with the real wiring, not a copy.
import type { RoomRemoveAsk } from '../../shared/room-view'
import { SharedAsks } from '../asks/shared-asks'
import { ROOM_REMOVE_ASK_MS } from './room-service'

export type RoomRemoveAsks = SharedAsks<Omit<RoomRemoveAsk, 'requestId'>, boolean>

/**
 * The same shared ask on every view of the window (first answer wins, `rooms.removeSettled` to the others, replayed in
 * `ready`, `ROOM_REMOVE_ASK_MS` then not removed). `views` is the ViewRegistry's `toWindow` only.
 */
export function createRoomRemoveAsks(
  views: { toWindow(windowId: number, channel: 'rooms.removeAsk' | 'rooms.removeSettled', payload: unknown): boolean },
  timeoutMs = ROOM_REMOVE_ASK_MS
): RoomRemoveAsks {
  return new SharedAsks<Omit<RoomRemoveAsk, 'requestId'>, boolean>({
    hooks: {
      send: (windowId, ask) => views.toWindow(windowId, 'rooms.removeAsk', ask),
      settled: (windowId, requestId) => views.toWindow(windowId, 'rooms.removeSettled', { requestId })
    },
    prefix: 'room-remove',
    refused: false,
    timeoutMs
  })
}

/**
 * The room's membership changed: the pending asks of `roomId` whose member is no longer in the live room are settled
 * as declined (`hasLiveMember`), so every view's dialog closes at once. Without it a dialog would stay up for the
 * whole timeout and its Remove click would fail on a member that is not there.
 */
export function settleGoneRemoveAsks(asks: RoomRemoveAsks, roomId: string, hasLiveMember: (name: string) => boolean): void {
  if (asks.size === 0) return
  asks.settleWhere((ask) => ask.roomId === roomId && !hasLiveMember(ask.name))
}
