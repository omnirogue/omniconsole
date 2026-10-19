import type {
  DeliverableCheck,
  DeliverableVerificationRecord
} from '../../shared/deliverable-verification-types'
import type { DeliverableVerifierSettings } from '../../shared/deliverable-verifier-settings'
import type { FinishedTurn } from '../next-steps/next-step-turn-signal'

export type DeliverableRecordInput = {
  id: string
  turn: FinishedTurn
  key: string
  connectionId: string | null
  requestId: string
  requestStartedAt: number | null
  checks: DeliverableCheck[]
  overall: DeliverableVerificationRecord['overall']
  settings: DeliverableVerifierSettings
  action: DeliverableVerificationRecord['action']
  repairsSent: number
  promptId?: string
  token?: string
}

/** The record one finished turn leaves: identities, what was found, and what happened next. */
export function buildDeliverableVerificationRecord(
  input: DeliverableRecordInput,
  checkedAt: number
): DeliverableVerificationRecord {
  const { turn } = input
  return {
    id: input.id,
    paneKey: turn.conversation.paneKey,
    worktreeId: turn.conversation.worktreeId,
    conversationKey: input.key,
    ...(turn.agent ? { agent: turn.agent } : {}),
    host: input.connectionId ? `ssh:${input.connectionId}` : 'local',
    turnKey: turn.turnKey,
    requestId: input.requestId,
    requestStartedAt: input.requestStartedAt,
    checkedAt,
    checks: input.checks,
    overall: input.overall,
    mode: input.settings.mode === 'on' ? 'on' : 'shadow',
    action: input.action,
    repairsSent: input.repairsSent,
    maxRepairs: input.settings.maxRepairs,
    ...(input.promptId ? { promptId: input.promptId } : {}),
    ...(input.token ? { token: input.token } : {})
  }
}
