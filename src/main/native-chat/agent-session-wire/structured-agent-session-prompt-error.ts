/** The agent no longer holds this prompt (it moved on, or the request is gone): no retry can deliver an answer. */
export class AgentSessionPromptGoneError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AgentSessionPromptGoneError'
  }
}

export function isAgentSessionPromptGoneError(
  error: unknown
): error is AgentSessionPromptGoneError {
  return error instanceof Error && error.name === 'AgentSessionPromptGoneError'
}
