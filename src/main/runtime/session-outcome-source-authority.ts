import {
  assertNoUnfinishedLegacySource,
  nextSessionOutcomeSourceId,
  isFinishedOutcomeChain
} from './session-outcome-source-uniqueness'
import { assertSessionOutcomeIndependentSource } from './session-outcome-source-fence'
import type { SessionChain } from '../../shared/session-chain-types'
import type { RpcContext } from './rpc/core'
import { sessionOutcomeStructuredAuthority } from './session-outcome-structured-authority'
import { readInferredSessionHandoffs } from './session-outcome-inferred-handoff'
import { readInferredSessionWaits } from './session-outcome-inferred-waits'
import type { ResolvedNextOutcomeWait } from '../../shared/next-outcome-wait-request'
import type { ResolvedNextOutcomeHandoff } from '../../shared/next-outcome-handoff-request'

export function sessionOutcomeHookInstruction(
  context: RpcContext,
  chain: Pick<SessionChain, 'sourcePaneKey' | 'worktreeId' | 'sourceWorktreeId'>
): string {
  const structured = sessionOutcomeStructuredAuthority(context, {
    paneKey: chain.sourcePaneKey,
    worktreeId: chain.sourceWorktreeId ?? chain.worktreeId
  })
  if (structured) {
    return structured.prompt
  }
  const authority = context.runtime.verifyOrchestrationCompatibilityCaller(
    context.orchestrationCompatibilityEvidence
  )
  const source = context.runtime.resolveTerminalPane(
    chain.sourcePaneKey,
    chain.sourceWorktreeId ?? chain.worktreeId
  )
  if (
    !authority ||
    authority.terminalHandle !== source.handle ||
    authority.paneKey !== chain.sourcePaneKey ||
    authority.hostScope.kind !== 'local'
  ) {
    throw new Error('The outcome caller has no current execution-host source authority.')
  }
  assertSessionOutcomeIndependentSource(context.runtime, source.handle)
  const prompt = context.runtime.getSessionOutcomeSourcePrompt(
    context.orchestrationCompatibilityEvidence
  )
  if (!prompt?.trim()) {
    throw new Error(
      'The source has no full attested user submission. Ensure its session is connected and its hooks or remote relay are up to date, then resubmit a complete, concise instruction or define the work through Next. Do not use a shortened preview; no Next steps were saved.'
    )
  }
  return prompt
}

export async function sessionOutcomeSource(
  context: RpcContext,
  input: { paneKey: string; worktreeId?: string }
): Promise<{
  chain: SessionChain
  prompt: string
  expectedRevision: number
  handoffs?: ResolvedNextOutcomeHandoff[]
  unresolvedRecipients?: string[]
  handoffError?: string
  waits?: ResolvedNextOutcomeWait[]
  waitError?: string
}> {
  if (!context.runtime.hasSessionOutcomeContinuation()) {
    throw new Error('Independent execution-host continuation is unavailable.')
  }
  const source =
    sessionOutcomeStructuredAuthority(context, input) ??
    context.runtime.resolveTerminalPane(input.paneKey, input.worktreeId)
  if (!source.worktreeId) {
    throw new Error('The source workspace is unverifiable.')
  }
  const candidates = context.runtime
    .listSessionChains()
    .filter(
      (chain) =>
        chain.sourcePaneKey === input.paneKey &&
        (chain.sourceWorktreeId ?? chain.worktreeId) === source.worktreeId &&
        (chain.placement ?? chain.hostId ?? 'local') === 'local'
    )
  assertNoUnfinishedLegacySource(candidates)
  const existing = candidates.find((chain) => chain.outcomeSet && !isFinishedOutcomeChain(chain))
  if (!existing && candidates.length && !candidates.some((chain) => chain.outcomeSet)) {
    throw new Error(
      'This source has a completed or cancelled legacy Next plan. Its steps and completion are not new outcome authority. Start a new source session, or explicitly define new work through Next.'
    )
  }
  const workspace = await context.runtime.showManagedTerminalWorkspace(`id:${source.worktreeId}`)
  const chain: SessionChain = existing ?? {
    id: nextSessionOutcomeSourceId(context.runtime.listSessionChains(), {
      sourcePaneKey: input.paneKey,
      worktreeId: source.worktreeId
    } as SessionChain),
    sourcePaneKey: input.paneKey,
    sourceRowKey: JSON.stringify(['local', source.worktreeId, input.paneKey]),
    worktreeId: source.worktreeId,
    workspacePath: workspace.path,
    hostId: 'local',
    placement: 'local',
    auto: true,
    steps: [],
    currentIndex: 0,
    state: 'waiting',
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
  // Dispatch capability and hook launch authority use the same commit verification path.
  const { sessionOutcomeMutationAuthority } = await import('./session-outcome-authority')
  const authority = sessionOutcomeMutationAuthority(context, chain, 'ai')
  if (!authority.instruction) {
    throw new Error('Source inference requires attested agent authority.')
  }
  const outcomeSource = {
    chain,
    prompt: authority.instruction,
    expectedRevision: chain.outcomeSet?.revision ?? 0
  }
  // Why read beside handoffs: a wait on a person resolves against the same signed-in roster.
  const waits = await readInferredSessionWaits(authority.instruction).then(
    (read) => ({ waits: read.waits }),
    (error) => ({ waitError: error instanceof Error ? error.message : String(error) })
  )
  try {
    const { handoffs, unresolvedRecipients } = await readInferredSessionHandoffs(
      authority.instruction
    )
    return { ...outcomeSource, handoffs, unresolvedRecipients, ...waits }
  } catch (error) {
    return {
      ...outcomeSource,
      handoffError: error instanceof Error ? error.message : String(error),
      ...waits
    }
  }
}
