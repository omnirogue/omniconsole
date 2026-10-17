/**
 * A message the door refused before any byte of it moved (`conversation-delivery.ts`).
 *
 * Sending it again cannot deliver it twice, so a sender that must never repeat itself — a
 * reviewer's notes to the agent — may try again. Every other delivery failure may have reached the
 * agent, and its result is unknown. Its own module, so a test that stubs the door keeps the class.
 */
export class ConversationNotSentError extends Error {
  constructor(error: unknown) {
    super(error instanceof Error ? error.message : String(error), { cause: error })
    this.name = 'ConversationNotSentError'
  }
}
