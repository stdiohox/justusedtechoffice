/**
 * Whether the person just stepped into a room by their own hand (a door
 * button, or Join on an invite), as opposed to the page simply mounting while
 * they were already inside. Only the first case moves focus into the room.
 */
let entered = false

export const markEnteredRoom = () => {
  entered = true
}

/** True once per entry; the next read is false again. */
export const consumeEnteredRoom = (): boolean => {
  const was = entered
  entered = false
  return was
}
