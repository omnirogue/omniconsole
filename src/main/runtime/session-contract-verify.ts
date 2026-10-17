/**
 * A launched session's contract lines, checked by a separate seat once the session finishes.
 *
 * Session prep writes a contract (an outcome and 3–6 Done When checks) and `session launch
 * --contract` carries Acceptance lines. Either way the lines are bound to the launched conversation
 * as an Outcome whose only stage is a verify gate, so the work is tested line by line instead of
 * being taken from the worker's own report. A failed gate stops and asks the owner, naming the
 * lines that failed: an automatic repair would need a second verification to count, which this
 * plan does not run.
 *
 * Nothing here launches or commits early: it waits until the session's first turn is under way,
 * because a chain whose source has not started yet could read an idle pane as a finished turn.
 */
import type { ConversationSource } from '../../shared/conversation-source'
import type { TuiAgent } from '../../shared/tui-agent'
import { upNextRowKey } from '../../shared/up-next-types'
import type { WorkPlan, WorkPlanActor, WorkPlanNode } from '../../shared/work-plan-types'
import type { OrcaRuntimeService } from './omni-runtime'
import { upNextChainFor } from './up-next'
import { upNextBaseChain } from './up-next-commit'
import { upNextCommitPlan } from './up-next-plan-edit'

export type ContractVerifyRequest = {
  worktreeId: string
  paneKey: string
  title: string
  doneWhen: readonly string[]
  agent: TuiAgent
  /** The brief's label for these lines: `DW` (session prep) or `A` (Acceptance). */
  label?: 'DW' | 'A'
}

/** A `retryable` refusal may clear up later (a slow first turn); the rest are final. */
export type ContractVerifyResult =
  | { attached: true }
  | { attached: false; reason: string; retryable?: boolean }

const FIRST_TURN_WAIT_MS = 180_000
const POLL_MS = 2_000

// A verify seat reads and runs checks; it does not need the session's frontier model.
const VERIFY_SEAT: Partial<Record<TuiAgent, { model: string; effort: string }>> = {
  claude: { model: 'sonnet', effort: 'medium' }
}

/** The line's id is its label in the brief, so the verifier and the worker name it alike. */
export function contractLineId(label: 'DW' | 'A', index: number): string {
  return `${label}${index + 1}`
}

export function contractVerifyPlan(request: ContractVerifyRequest): WorkPlan {
  const ids = request.doneWhen.map((_, at) => contractLineId(request.label ?? 'DW', at))
  const verifier: WorkPlanActor = { agent: request.agent, ...VERIFY_SEAT[request.agent] }
  const nodes: WorkPlanNode[] = [
    {
      kind: 'worker',
      id: 'verify',
      role: 'verify',
      instruction: '',
      actor: verifier,
      route: 'new-session',
      verdict: { kind: 'verify', over: ids, consumed: 'gate' }
    },
    { kind: 'finish', id: 'finish', how: 'complete' }
  ]
  return {
    outcome: {
      title: request.title,
      outputKind: 'work',
      doneWhen: request.doneWhen.map((text, at) => ({
        id: ids[at]!,
        text,
        evidence: 'verdict' as const
      }))
    },
    nodes
  }
}

/** True once the session is working on its brief (or already finished a real turn). */
async function firstTurnStarted(
  runtime: OrcaRuntimeService,
  request: ContractVerifyRequest,
  clock: { now: () => number; sleep: (ms: number) => Promise<void> }
): Promise<boolean> {
  const deadline = clock.now() + FIRST_TURN_WAIT_MS
  while (clock.now() < deadline) {
    try {
      const pane = runtime.resolveTerminalPane(request.paneKey, request.worktreeId)
      const hook = runtime.getFreshAgentHookStatusForHandle(pane.handle)
      if (hook?.state === 'working' || (hook?.state === 'done' && !hook.sessionBoundary)) {
        return true
      }
    } catch {
      // The pane may not be listed yet; it is read again on the next poll.
    }
    await clock.sleep(POLL_MS)
  }
  return false
}

export async function attachContractVerify(
  runtime: OrcaRuntimeService,
  request: ContractVerifyRequest,
  clock = {
    now: () => Date.now(),
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
  }
): Promise<ContractVerifyResult> {
  if (!request.doneWhen.length) {
    return { attached: false, reason: 'it has no Done when lines' }
  }
  if (!(await firstTurnStarted(runtime, request, clock))) {
    return {
      attached: false,
      reason: 'the session did not start its first turn within 3 minutes',
      retryable: true
    }
  }
  const conversation: ConversationSource = {
    worktreeId: request.worktreeId,
    paneKey: request.paneKey,
    kind: 'pty'
  }
  const rowKey = upNextRowKey(conversation)
  // A plan someone already composed for this conversation is theirs; it is never replaced.
  if (upNextChainFor(runtime, rowKey)) {
    return { attached: false, reason: 'the conversation already has a plan' }
  }
  const chain = await upNextBaseChain({ runtime, conversationId: conversation, rowKey }, null)
  const seat = VERIFY_SEAT[request.agent]
  await upNextCommitPlan(
    {
      runtime,
      agent: request.agent,
      chain,
      existing: null,
      ...(seat
        ? {
            catalogue: [
              {
                agent: request.agent,
                models: [{ id: seat.model, label: seat.model, efforts: [seat.effort] }]
              }
            ]
          }
        : {})
    },
    contractVerifyPlan(request),
    'Verify the contract lines this session was launched with.'
  )
  return { attached: true }
}
