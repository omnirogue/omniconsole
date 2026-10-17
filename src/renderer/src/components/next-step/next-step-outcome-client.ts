import type { SessionFinishChoice } from '../../../../shared/session-finish-intent'
import {
  sessionOutcomeConnection,
  OutcomeHostUnsupportedError
} from '@/lib/session-outcome-connection'
import { hasRuntimeRpcErrorCode } from '@/runtime/runtime-rpc-client'
import { getSessionChainEntry, getAllSessionChainEntries } from '@/lib/session-chain-registry'
import { outcomeOwnerKey, type SessionOutcomeOwner } from '@/lib/session-outcome-owner'
import {
  sessionOutcomeChainForHost,
  sessionOutcomeChainForClient,
  type SessionOutcomeHostCapabilities
} from '../../../../shared/session-outcome-routing'
import type { SessionChain } from '../../../../shared/session-chain-types'
import type { HumanAttentionRequest } from '../../../../shared/session-human-attention'
import type { SessionRunPhase } from '../../../../shared/session-run-lifecycle'
import type { SessionOutcomeDefinition } from '../../../../shared/session-outcome-types'
import type { NextStepOutcomeDraft } from '../../../../shared/next-step-draft'
import {
  compileNextStepOutcomes,
  type NextOutcomeDefinitionContext
} from '../../../../shared/next-outcome-definition-compile'

export type OutcomeCapabilities = SessionOutcomeHostCapabilities
export type OutcomeProgress = {
  chain: SessionChain
  lifecycle: 'waiting' | 'needs-you' | 'complete'
  /** The run-lifecycle phase; absent from a host that predates the policy. */
  phase?: SessionRunPhase
  satisfied: number
  total: number
  reasons: string[]
  /** Valid open requests addressed to the owner: the whole of "needs you". */
  attention?: HumanAttentionRequest[]
}

const ownerConnection = (owner: SessionOutcomeOwner) => sessionOutcomeConnection(owner).negotiate()
function ownerForId(id: string, owner?: SessionOutcomeOwner): SessionOutcomeOwner {
  const resolved = owner ?? getSessionChainEntry(id)?.chain
  if (!resolved) {
    throw new Error('The outcome owner is unknown or ambiguous. Supply the session execution host.')
  }
  return resolved
}
export async function getOutcomeCapabilities(
  owner?: SessionOutcomeOwner
): Promise<OutcomeCapabilities> {
  if (!owner) {
    throw new Error('Select the session execution owner before reading outcome capabilities.')
  }
  return (await ownerConnection(owner)).capabilities
}
export async function commitSessionOutcomes(args: {
  sessionFinish?: SessionFinishChoice
  chain: SessionChain
  expectedRevision: number
  expectedAttachedTask?: { taskId: string; sessionId: string }
  outcomes: SessionOutcomeDefinition[]
  removals?: { outcomeId: string; reason: string }[]
}): Promise<SessionChain> {
  const connection = await ownerConnection(args.chain)
  if (
    args.chain.steps.some((step) => step.kind !== 'handoff' && step.review?.repairWithSource) &&
    connection.capabilities.sourceReviewRepairs !== 1
  ) {
    throw new Error('Update the session execution host to repair findings between review rounds.')
  }
  if (
    args.chain.steps.some(
      (step) => step.kind === 'handoff' && step.handoff.agentRecipients?.length
    ) &&
    connection.capabilities.handoffAgents !== 1
  ) {
    throw new Error(
      'Update the session execution host to send to existing agent sessions when done.'
    )
  }
  if (
    args.chain.steps.some(
      (step) =>
        step.kind === 'handoff' &&
        (step.handoff.transcriptSource || step.handoff.deliverables.kind === 'files')
    ) &&
    connection.capabilities.handoffAttachments !== 1
  ) {
    throw new Error(
      'Update the session execution host to send messages, exact files/folders, and complete session history when done.'
    )
  }
  if (
    args.chain.steps.some((step) => step.kind === 'handoff' && step.handoff.destinationDirectory) &&
    connection.capabilities.handoffFolders !== 1
  ) {
    throw new Error(
      'Update the session execution host to save handoff files in the selected folder.'
    )
  }
  if (
    (args.sessionFinish ||
      args.outcomes.some((outcome) =>
        outcome.conditions.some((condition) => condition.kind === 'session')
      )) &&
    connection.capabilities.sessionFinish !== 1
  ) {
    throw new Error('Update the execution host to save this session finish choice.')
  }
  const result = await connection.call<{ chain: SessionChain }>('sessionChain.commitOutcomes', {
    ...args,
    chain: sessionOutcomeChainForHost(args.chain, connection.target),
    source: 'user'
  })
  return sessionOutcomeChainForClient(result.chain, connection.target)
}
export async function getOutcomeProgress(
  id: string,
  owner?: SessionOutcomeOwner,
  options?: { verifySourceReady?: boolean }
): Promise<OutcomeProgress> {
  const connection = await ownerConnection(ownerForId(id, owner))
  if (options?.verifySourceReady && connection.capabilities.sessionFinish !== 1) {
    throw new Error('Update the execution host before applying a session finish choice.')
  }
  const hostId = getSessionChainEntry(id, owner)?.chain.id ?? id
  const progress = await connection.call<OutcomeProgress>('sessionChain.outcomeProgress', {
    id: hostId,
    ...(options?.verifySourceReady ? { verifySourceReady: true } : {})
  })
  return { ...progress, chain: sessionOutcomeChainForClient(progress.chain, connection.target) }
}
export async function listSessionOutcomesForOwner(
  owner: SessionOutcomeOwner
): Promise<SessionChain[]> {
  const route = sessionOutcomeConnection(owner)
  let result: { chains: SessionChain[] }
  try {
    const connection = await route.negotiate()
    result = await connection.call<{ chains: SessionChain[] }>('sessionChain.list')
    const current = await connection.call<OutcomeCapabilities>('sessionChain.outcomeCapabilities')
    if (
      !current.durableContinuation ||
      current.executionRuntimeId !== connection.capabilities.executionRuntimeId
    ) {
      throw new Error(
        'The execution runtime changed while reading outcomes. Reconnect before trusting an empty or completed set.'
      )
    }
  } catch (error) {
    if (!(error instanceof OutcomeHostUnsupportedError)) {
      throw error
    }
    result = await route.call<{ chains: SessionChain[] }>('sessionChain.list')
  }
  const chains = result.chains
    .filter((chain) => chain.outcomeSet)
    .map((chain) => sessionOutcomeChainForClient(chain, route.target))
  const known = getAllSessionChainEntries().filter(
    (entry) =>
      entry.chain.outcomeSet &&
      outcomeOwnerKey({ hostId: entry.chain.placement ?? entry.chain.hostId ?? 'local' }) ===
        outcomeOwnerKey(owner)
  )
  if (known.some((entry) => !chains.some((chain) => chain.id === entry.chain.id))) {
    throw new Error(
      'The owning host did not return a previously committed obligation. Restore its profile before marking this session complete.'
    )
  }
  return chains
}
type EvidenceInput = {
  id: string
  expectedRevision: number
  outcomeId: string
  conditionId: string
  owner?: SessionOutcomeOwner
}
async function evidenceCall(
  method: string,
  args: EvidenceInput & { version?: string }
): Promise<SessionChain> {
  const { owner, ...params } = args
  const connection = await ownerConnection(ownerForId(args.id, owner))
  const result = await connection.call<{ chain: SessionChain }>(method, {
    ...params,
    id: getSessionChainEntry(args.id, owner)?.chain.id ?? args.id
  })
  return sessionOutcomeChainForClient(result.chain, connection.target)
}
export const verifySessionOutcome = (args: EvidenceInput): Promise<SessionChain> =>
  evidenceCall('sessionChain.verifyOutcome', args)
export const approveSessionOutcomeReview = (
  args: EvidenceInput & { version: string }
): Promise<SessionChain> => evidenceCall('sessionChain.approveOutcomeReview', args)
export type SessionOutcomeWaitChoice = 'keep-waiting' | 'continue' | 'cancel'
/** The owner's answer to a wait that came back as something other than a yes. */
export const chooseSessionOutcomeWait = (
  args: EvidenceInput & { choice: SessionOutcomeWaitChoice }
): Promise<SessionChain> => evidenceCall('sessionChain.chooseOutcomeWait', args)
export async function resumeSessionOutcomes(args: {
  id: string
  expectedRevision: number
  owner?: SessionOutcomeOwner
}): Promise<SessionChain> {
  const { owner, ...params } = args
  const connection = await ownerConnection(ownerForId(args.id, owner))
  const result = await connection.call<{ chain: SessionChain }>('sessionChain.resumeOutcomes', {
    ...params,
    id: getSessionChainEntry(args.id, owner)?.chain.id ?? args.id
  })
  return sessionOutcomeChainForClient(result.chain, connection.target)
}
/**
 * Tell the owning host what this window did with a finished session. The `operationId` names the
 * one operation the host asked for, so a repeat is harmless and a stale one is ignored there.
 */
export async function reportSessionDisposition(args: {
  chain: SessionChain
  operationId: string
  ok: boolean
  error?: string
}): Promise<SessionChain> {
  const connection = await ownerConnection(args.chain)
  const result = await connection.call<{ chain: SessionChain }>('sessionChain.reportDisposition', {
    chainId: getSessionChainEntry(args.chain.id, args.chain)?.chain.id ?? args.chain.id,
    operationId: args.operationId,
    ok: args.ok,
    ...(args.error ? { error: args.error.slice(0, 1_000) } : {})
  })
  return sessionOutcomeChainForClient(result.chain, connection.target)
}
/** The person asks for the close or save to be tried again after its bounded retries ran out. */
export async function retrySessionDisposition(chain: SessionChain): Promise<SessionChain> {
  const connection = await ownerConnection(chain)
  const result = await connection.call<{ chain: SessionChain }>('sessionChain.retryDisposition', {
    chainId: getSessionChainEntry(chain.id, chain)?.chain.id ?? chain.id
  })
  return sessionOutcomeChainForClient(result.chain, connection.target)
}
/** Ask the owning host to converge now (reconnect, refresh). A host that predates it just ticks. */
export async function reconcileSessionOutcomes(owner: SessionOutcomeOwner): Promise<void> {
  try {
    const connection = await ownerConnection(owner)
    await connection.call('sessionChain.reconcile', {})
  } catch (error) {
    if (
      !(error instanceof OutcomeHostUnsupportedError) &&
      !hasRuntimeRpcErrorCode(error, 'method_not_found')
    ) {
      throw error
    }
  }
}
export function outcomeDefinitionsFromDraft(
  outcomes: readonly NextStepOutcomeDraft[],
  context: NextOutcomeDefinitionContext
): SessionOutcomeDefinition[] {
  return compileNextStepOutcomes(outcomes, context)
}
