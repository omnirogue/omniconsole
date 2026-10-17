export const SOURCE_CONTROL_GENERATION_TIMEOUT_MS = 60_000
export const MAX_SOURCE_CONTROL_AGENT_OUTPUT_BYTES = 4 * 1024 * 1024
// Why: an assisted brief reads the workspace and weighs scope, so it may need longer than a commit message.
export const ASSISTED_BRIEF_GENERATION_TIMEOUT_MS = 180_000
// Why: session prep may research several files before returning structured fields.
export const SESSION_PREP_GENERATION_TIMEOUT_MS = 600_000
// Why: suggestions answer from the reply they are given; a slow one is stale before it lands.
export const NEXT_STEP_SUGGESTION_GENERATION_TIMEOUT_MS = 90_000

export function sourceControlGenerationTimeoutMs(operation: string): number {
  if (operation === 'session-prep') {
    return SESSION_PREP_GENERATION_TIMEOUT_MS
  }
  if (operation === 'assisted-brief') {
    return ASSISTED_BRIEF_GENERATION_TIMEOUT_MS
  }
  return operation === 'next-step-suggestions' || operation === 'session-summary'
    ? NEXT_STEP_SUGGESTION_GENERATION_TIMEOUT_MS
    : SOURCE_CONTROL_GENERATION_TIMEOUT_MS
}
