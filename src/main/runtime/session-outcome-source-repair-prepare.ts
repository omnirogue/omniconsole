import type { SessionChain } from '../../shared/session-chain-types'
import { isTuiAgent } from '../../shared/tui-agent-config'
import type { OrcaRuntimeService } from './omni-runtime'
import { observeSessionOutcomeSource } from './session-outcome-source'
import {
  materializeSessionOutcomeSourceRepairs,
  SessionOutcomeSourceRepairActorError
} from './session-outcome-source-repairs'

/** Save the verified original actor before the source pane can close or a successor can launch. */
export async function prepareSessionOutcomeSourceRepairs(
  runtime: OrcaRuntimeService,
  chain: SessionChain
): Promise<SessionChain> {
  const owner = chain.outcomeSet?.continuation
  if (!owner?.sourceReady || owner.planningSource) {
    return chain
  }
  try {
    return materializeSessionOutcomeSourceRepairs(chain)
  } catch (error) {
    if (!(error instanceof SessionOutcomeSourceRepairActorError)) {
      throw error
    }
  }
  const before = await observeSessionOutcomeSource(runtime, chain)
  if (!before.ready || !before.version || before.version !== owner.sourceVersion) {
    throw new Error('The source completion changed before its repair owner was captured.')
  }
  const context = await runtime.readSessionOutcomeSourceContext(
    chain.sourcePaneKey,
    chain.sourceWorktreeId ?? chain.worktreeId
  )
  const binding = owner.sourcePacket ?? owner.sourceBinding
  if (
    !context ||
    !isTuiAgent(context.agent) ||
    context.paneKey !== chain.sourcePaneKey ||
    (binding &&
      (context.handle !== binding.sourceHandle ||
        context.processIncarnation !== binding.processIncarnation))
  ) {
    throw new Error('The original source agent and model could not be verified for review repairs.')
  }
  const after = await observeSessionOutcomeSource(runtime, chain)
  if (!after.ready || after.version !== before.version) {
    throw new Error('The source completion changed while its repair owner was captured.')
  }
  return materializeSessionOutcomeSourceRepairs(chain, {
    agent: context.agent,
    model: context.model,
    ...(context.effort ? { effort: context.effort } : {})
  })
}
