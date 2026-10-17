import type { WorkReads } from './backoffice-work-reads'

/** The idle marker every read starts from; shared so the store and the factory agree. */
export const IDLE = { phase: 'idle' } as const

/** Every read in its idle state: the shape a scope starts from and resets to. */
export function emptyBackofficeReads(): WorkReads {
  return {
    todo: IDLE,
    receivedOpen: IDLE,
    receivedHistory: IDLE,
    sent: IDLE,
    roster: IDLE,
    humanActions: IDLE,
    messages: IDLE
  }
}
