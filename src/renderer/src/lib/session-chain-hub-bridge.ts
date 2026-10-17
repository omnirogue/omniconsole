import { handoffApi } from '@/components/handoffs/handoff-client'
import { workflowData } from '@/lib/console-workflow-client'
import {
  CHAIN_STEP_HANDOFF_ACTION,
  chainStepOperationIds,
  chainStepThreadBody,
  chainStepThreadTitle
} from '../../../shared/session-chain-hub-step'
import {
  isSessionChainAgentStep,
  type SessionChain,
  type SessionChainAgentStep,
  type SessionChainStep
} from '../../../shared/session-chain-types'

/**
 * The bridge between the runtime that runs agent steps and the record people read.
 *
 * Orcha never wrote to the hub, so a chain running for an hour was invisible in Waiting For and a
 * chain that failed was invisible everywhere. Each agent step now opens one `fyi` thread from the
 * owner to the owner, which the hub's attention list excludes by design — Waiting For only — and
 * the step's end resolves it (finished) or replies on it (failed, so it surfaces in Needs You).
 *
 * Every write carries a deterministic operation id, so a retry or a restart replays the same
 * thread and the same entry instead of minting a second one. Nothing here can fail a chain: the
 * record is worth having, never worth stopping the work for.
 */
let cachedEmployeeId: string | null | undefined

/** Who the hub says the signed-in person is; the queue answer names them, so nothing is guessed. */
export async function currentEmployeeId(): Promise<string | null> {
  if (cachedEmployeeId !== undefined) {
    return cachedEmployeeId
  }
  try {
    const queue = workflowData(await handoffApi().list({}))
    if (/^emp_[A-Za-z0-9_-]{1,120}$/.test(queue.assignee)) {
      cachedEmployeeId = queue.assignee
      return cachedEmployeeId
    }
  } catch {
    // An unreachable console is not a chain failure; the step goes unmirrored this time.
  }
  // Why nothing is cached here: an app that started before the console was reachable would
  // otherwise answer "nobody" for the rest of its life, and every later step would go unrecorded
  // with no way back. Only a real answer is worth remembering.
  return null
}

export function resetCurrentEmployeeIdForTests(): void {
  cachedEmployeeId = undefined
}

function agentSteps(chain: Pick<SessionChain, 'steps'>): SessionChainAgentStep[] {
  return chain.steps.filter((step): step is SessionChainAgentStep => isSessionChainAgentStep(step))
}

export type ChainBridgeAccess = {
  getChain: () => SessionChain | null
  update: (patch: Partial<SessionChain>) => SessionChain | null
  persist: (chain: SessionChain) => Promise<void>
}

async function patchStep(
  access: ChainBridgeAccess,
  stepId: string,
  patch: Partial<SessionChainAgentStep>
): Promise<void> {
  const chain = access.getChain()
  if (!chain) {
    return
  }
  const steps: SessionChainStep[] = chain.steps.map((step) =>
    step.id === stepId && isSessionChainAgentStep(step) ? { ...step, ...patch } : step
  )
  const next = access.update({ steps })
  if (next) {
    await access.persist(next).catch((error) => {
      console.warn('[chain-bridge] could not save the step’s thread id', error)
    })
  }
}

/**
 * Open the thread that stands for a launched agent step. Returns the thread id, or null when the
 * console could not be reached — which is recorded nowhere and stops nothing.
 */
export async function announceChainStep(
  access: ChainBridgeAccess,
  step: SessionChainAgentStep,
  sessionLabel: string
): Promise<string | null> {
  const chain = access.getChain()
  if (!chain || step.hubThreadId) {
    return step.hubThreadId ?? null
  }
  const me = await currentEmployeeId()
  if (!me) {
    return null
  }
  const steps = agentSteps(chain)
  const position = steps.findIndex((candidate) => candidate.id === step.id) + 1
  try {
    const receipt = workflowData(
      await handoffApi().sendCardless({
        title: chainStepThreadTitle({
          agent: step.agent,
          sessionLabel,
          position: Math.max(1, position),
          total: steps.length
        }),
        recipient: me,
        action: CHAIN_STEP_HANDOFF_ACTION,
        note: chainStepThreadBody({
          prompt: step.prompt,
          workspacePath: chain.workspacePath,
          ...(chain.hostId ? { hostLabel: chain.hostId } : {})
        }),
        operationId: chainStepOperationIds(chain.id, step.id).announce,
        attachments: []
      })
    )
    const threadId = receipt.thread_id ?? null
    if (threadId) {
      await patchStep(access, step.id, { hubThreadId: threadId })
    }
    return threadId
  } catch (error) {
    console.warn('[chain-bridge] could not open the step’s thread', error)
    return null
  }
}

/** Close a step's thread: `done` when it finished, `reply` when it failed (Needs You). */
export async function settleChainStep(
  access: ChainBridgeAccess,
  step: SessionChainAgentStep,
  outcome: { ok: true } | { ok: false; detail: string }
): Promise<void> {
  const chain = access.getChain()
  if (!chain || !step.hubThreadId || step.hubSettledAt) {
    return
  }
  const ids = chainStepOperationIds(chain.id, step.id)
  try {
    workflowData(
      await handoffApi().respond({
        threadId: step.hubThreadId,
        kind: outcome.ok ? 'done' : 'reply',
        note: outcome.ok
          ? `${step.agent} finished this step.`
          : `${step.agent} did not finish this step. ${outcome.detail}`.slice(0, 8192),
        operationId: outcome.ok ? ids.done : ids.failed
      })
    )
    await patchStep(access, step.id, { hubSettledAt: Date.now() })
  } catch (error) {
    console.warn('[chain-bridge] could not close the step’s thread', error)
  }
}

/** Close the threads of steps the runner has just seen finish. */
export async function settleChainSteps(
  access: ChainBridgeAccess,
  steps: readonly SessionChainAgentStep[]
): Promise<void> {
  for (const step of steps) {
    await settleChainStep(access, step, { ok: true })
  }
}

/** Every launched step whose thread is still open, newest first. */
export function unsettledChainSteps(chain: Pick<SessionChain, 'steps'>): SessionChainAgentStep[] {
  return agentSteps(chain).filter((step) => step.hubThreadId && !step.hubSettledAt)
}

/** A chain that failed: every open step thread gets the reason, so the work reaches Needs You. */
export async function reportChainFailure(access: ChainBridgeAccess, detail: string): Promise<void> {
  const chain = access.getChain()
  if (!chain) {
    return
  }
  for (const step of unsettledChainSteps(chain)) {
    await settleChainStep(access, step, { ok: false, detail })
  }
}
