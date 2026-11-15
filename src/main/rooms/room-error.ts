// What every room module refuses with, apart from the registry it used to live in: the docs store, the fence and the
// delivery throw or name these without needing the registry itself.

export type RoomErrorCode = 'not-found' | 'invalid' | 'limit' | 'conflict' | 'ended' | 'error'

/** A refusal with a stable code; `not-found` is also the answer for another plugin's room (no way to probe ids). */
export class RoomError extends Error {
  constructor(
    readonly code: RoomErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'RoomError'
  }
}

/**
 * The sender of main's own notices to a room (a member's tab closed, design-rooms.md §7 "Failures"). A reserved name,
 * so no member can take it; never the person.
 */
export const SYSTEM_SENDER = 'system'
