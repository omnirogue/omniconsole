import type { ParsedAgentStatusPayload } from './agent-status-types'

type InteractiveStatus = Pick<ParsedAgentStatusPayload, 'agentType' | 'state' | 'interactivePrompt'>

export function pendingOmpPromptOutranksTerminalStatus(
  pending: InteractiveStatus | null | undefined,
  observed: InteractiveStatus | null | undefined
): boolean {
  return (
    pending?.agentType === 'omp' &&
    pending.state === 'blocked' &&
    pending.interactivePrompt != null &&
    observed?.state === 'working' &&
    (observed.agentType == null || observed.agentType === 'unknown' || observed.agentType === 'omp')
  )
}
