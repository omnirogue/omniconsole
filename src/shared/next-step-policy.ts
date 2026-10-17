import { compileNextStepChain } from './next-step-compile'
import type { NextStepDraft } from './next-step-draft'
import {
  sessionChainPolicyBlocks,
  sessionChainPolicyProblems,
  type SessionChainPolicyProblem,
  type SessionChainSource
} from './session-chain-policy'

/**
 * The review rules a draft would break once compiled. The draft is compiled with placeholder
 * ids, exactly as the arm check does, so the answer is the one the sent plan would get.
 */
export function nextStepDraftPolicyProblems(
  draft: NextStepDraft,
  source: SessionChainSource | null,
  cardlessHandoffs = false
): SessionChainPolicyProblem[] {
  // Why the default: a compiler that reports problems and no steps has nothing to check.
  const { steps = [] } = compileNextStepChain({
    draft,
    cardlessHandoffs,
    chainId: 'chn_preview',
    workspacePath: '/',
    sessionLabel: 'session',
    defaultNote: 'note',
    now: 0,
    mintStepId: (position) => `step_${position}`,
    mintOperationId: () => 'op_preview_0000'
  })
  return sessionChainPolicyProblems({ steps }, source)
}

/**
 * The review rules an outcome plan would break, as the plain messages a dialog shows beside
 * the draft's own problems. The source is the session the plan runs after.
 */
export function nextStepDraftPolicyBlockMessages(
  draft: NextStepDraft,
  sourceAgent: string | null | undefined,
  sourceModel: string | null
): string[] {
  const source = sourceAgent ? { agent: sourceAgent, model: sourceModel } : null
  return sessionChainPolicyBlocks(nextStepDraftPolicyProblems(draft, source, true)).map(
    (problem) => problem.message
  )
}
