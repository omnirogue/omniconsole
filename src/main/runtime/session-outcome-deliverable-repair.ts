/**
 * A finished outcome whose promised file is missing, given back to the agent that could still
 * write it — at most `SESSION_OUTCOME_DELIVERABLE_REPAIRS_MAX` times per outcome revision.
 *
 * The prompt goes to THIS run's own conversation through the person's own send door
 * (`conversation-prompt-now.ts`), after a finished turn, as a reviewer's notes do
 * (`up-next-review-fix.ts`). Each repair is recorded durably before it is admitted; when the turn
 * that answers it ends, the record settles and the next pass verifies again. A send whose result
 * is unknown counts and is never sent again; one the door refused before any byte moved is
 * withdrawn and sent again later under a new prompt id.
 */

import { createHash, randomUUID } from 'node:crypto'
import { conversationSourceRowKey } from '../../shared/conversation-source'
import type { PromptQueue } from '../../shared/prompt-queue-types'
import { SESSION_RECOVERING_MAX_MS } from '../../shared/session-outcome-block'
import type { SessionChain } from '../../shared/session-chain-types'
import type { SessionOutcome, SessionOutcomeCondition } from '../../shared/session-outcome-types'
import { observeConversationReadiness } from './conversation-readiness'
import { sendConversationPromptNow } from './conversation-prompt-now'
import {
  openSessionOutcomeDeliverableRepair,
  SESSION_OUTCOME_DELIVERABLE_REPAIR_CODE,
  SESSION_OUTCOME_DELIVERABLE_REPAIRS_MAX,
  sessionOutcomeDeliverableRepairHold,
  sessionOutcomeDeliverableRepairKey,
  unprovenSessionOutcomeFiles
} from './session-outcome-deliverable-repair-hold'
import {
  sessionOutcomeDeliverableRepairStore,
  type SessionOutcomeDeliverableRepairStore
} from './session-outcome-deliverable-repair-store'
import type { OrcaRuntimeService } from './omni-runtime'
import { isPromptQueueSendingOnConversation } from './prompt-queue-drain'
import { sameConversationSource } from './session-outcome-conversation-turn'

export type SessionOutcomeDeliverableRepairAccess = {
  runtime: OrcaRuntimeService
  read: () => SessionChain
  /** This host's epoch: the prompt queue's receipt names the process that sent it. */
  epoch: string
  now: number
}

export const SESSION_OUTCOME_DELIVERABLE_REPAIR_NO_CONVERSATION =
  'The conversation this work belongs to is no longer open, so its agent cannot be asked to finish the missing files.'
export const SESSION_OUTCOME_DELIVERABLE_REPAIR_UNDELIVERED =
  'The request to finish the missing files could not be given to the agent.'
const PROMPT_MAX_CHARS = 2_000
const SETTLED_RECOVERY_PHASES = new Set(['delivered', 'cancelled'])
const LISTED_FILES_MAX = 10

export function sessionOutcomeDeliverableRepairPrompt(input: {
  outcome: SessionOutcome
  files: readonly SessionOutcomeCondition[]
  attempt: number
}): string {
  const { outcome, files, attempt } = input
  const reason = outcome.blockedReason?.trim().slice(0, 300)
  return [
    `[from Deliverable check ${attempt}/${SESSION_OUTCOME_DELIVERABLE_REPAIRS_MAX}] “${outcome.title}” is not finished: these promised files were not found.`,
    ...files
      .slice(0, LISTED_FILES_MAX)
      .map((file, index) => `${index + 1}. ${file.target}${file.label ? ` (${file.label})` : ''}`),
    ...(files.length > LISTED_FILES_MAX ? [`…and ${files.length - LISTED_FILES_MAX} more.`] : []),
    ...(reason ? ['', `The check said: ${reason}`] : []),
    '',
    'Create or fix each one here. If one cannot be done, say which and why instead of retrying it.',
    'Do not take any irreversible or outward-facing step that this conversation has not already approved.',
    'When this turn ends, the files will be checked again.'
  ]
    .join('\n')
    .slice(0, PROMPT_MAX_CHARS)
}

function queueRecoveryPending(queue: PromptQueue | null): boolean {
  return Boolean(queue?.recovery && !SETTLED_RECOVERY_PHASES.has(queue.recovery.phase))
}

function repairPromptId(key: string): string {
  return `deliverable-repair-${createHash('sha256').update(key).digest('hex').slice(0, 32)}`
}

async function advanceRepair(
  access: SessionOutcomeDeliverableRepairAccess,
  store: SessionOutcomeDeliverableRepairStore,
  chain: SessionChain,
  outcome: SessionOutcome
): Promise<void> {
  const key = sessionOutcomeDeliverableRepairKey(chain, outcome)
  const records = store.list(key)
  const files = unprovenSessionOutcomeFiles(outcome)
  const source = sameConversationSource(access.runtime, chain)
  if (!source) {
    // Its pane may not be restored yet; a conversation still missing once the block has gone
    // stale is gone, nothing can deliver a repair, and the outcome fails as it did before.
    if (access.now - (outcome.block?.since ?? access.now) < SESSION_RECOVERING_MAX_MS) {
      throw new Error(SESSION_OUTCOME_DELIVERABLE_REPAIR_NO_CONVERSATION)
    }
    store.add({
      ...key,
      attempt: records.length + 1,
      conditionIds: files.map((file) => file.id).slice(0, 64),
      createdAt: access.now,
      unrepairable: SESSION_OUTCOME_DELIVERABLE_REPAIR_NO_CONVERSATION
    })
    return
  }
  const readiness = await observeConversationReadiness(access.runtime, source)
  // Lost contact proves nothing about the turn: the block waits, or goes stale like any other.
  if (readiness.unverifiable) {
    return
  }
  const rowKey = conversationSourceRowKey(source)
  const queued = access.runtime.readPromptQueue(rowKey)
  const queue = queued?.entries ?? []
  const open = openSessionOutcomeDeliverableRepair(records)
  if (open?.promptId) {
    if (open.deliveredAt === undefined) {
      const entry = queue.find((row) => row.id === open.promptId)
      if (entry?.state === 'sending' || entry?.state === 'queued') {
        return
      }
      store.update(
        open.promptId,
        entry?.state === 'delivered'
          ? { deliveredAt: entry.deliveredAt ?? access.now }
          : {
              failed: (entry?.reason ?? SESSION_OUTCOME_DELIVERABLE_REPAIR_UNDELIVERED).slice(
                0,
                1_000
              )
            }
      )
      return
    }
    // The repair turn is the NEXT ending of this conversation after the one the prompt followed.
    if (
      readiness.ready &&
      readiness.version &&
      readiness.version.slice(0, 500) !== open.turnVersion
    ) {
      store.update(open.promptId, { settledAt: access.now })
    }
    return
  }
  // The record decides, not the block this pass read: a budget spent since then sends nothing.
  // A finished turn with an identity, never ahead of the person's own queued prompts, and never
  // over a capacity recovery, which any newly queued prompt would cancel.
  if (
    queueRecoveryPending(queued) ||
    sessionOutcomeDeliverableRepairHold(chain, chain.outcomeSet!, outcome)?.block.class !==
      'recovering' ||
    !files.length ||
    !readiness.ready ||
    !readiness.version ||
    isPromptQueueSendingOnConversation(access.runtime, source) ||
    queue.some((row) => row.state === 'queued' || row.state === 'sending')
  ) {
    return
  }
  const attempt = records.length + 1
  const promptId = repairPromptId(
    [key.chainId, key.outcomeId, key.outcomeRevision, key.planVersion, attempt, randomUUID()].join(
      '\n'
    )
  )
  // Durable before the prompt is admitted: a restart knows which prompt, and which ending it follows.
  store.add({
    ...key,
    attempt,
    promptId,
    turnVersion: readiness.version.slice(0, 500),
    conditionIds: files.map((file) => file.id).slice(0, 64),
    createdAt: access.now
  })
  let result: Awaited<ReturnType<typeof sendConversationPromptNow>>
  try {
    result = await sendConversationPromptNow(
      access.runtime,
      source,
      { id: promptId, text: sessionOutcomeDeliverableRepairPrompt({ outcome, files, attempt }) },
      access.epoch
    )
  } catch (error) {
    // The queue refused to admit it (this runtime keeps no queue, or the entry is invalid): nothing
    // moved, and nothing will deliver a repair here, so the outcome fails as it did before.
    if (!access.runtime.readPromptQueue(rowKey)?.entries.some((row) => row.id === promptId)) {
      const reason = error instanceof Error ? error.message : String(error)
      store.update(promptId, {
        unrepairable:
          reason.trim().slice(0, 1_000) || SESSION_OUTCOME_DELIVERABLE_REPAIR_UNDELIVERED
      })
    }
    throw error
  }
  if (result.notSent) {
    // Nothing moved: the record and entry are withdrawn, and a later pass asks again.
    access.runtime.removePromptQueueEntry(rowKey, promptId)
    store.remove(promptId)
    throw new Error(result.entry?.reason ?? SESSION_OUTCOME_DELIVERABLE_REPAIR_UNDELIVERED)
  }
  store.update(
    promptId,
    result.entry?.state === 'delivered'
      ? { deliveredAt: result.entry.deliveredAt ?? access.now }
      : {
          failed: (result.entry?.reason ?? SESSION_OUTCOME_DELIVERABLE_REPAIR_UNDELIVERED).slice(
            0,
            1_000
          )
        }
  )
}

/**
 * One pass over this run's outcomes held for a repair. It never throws: a repair the door refused
 * is asked again next pass, and a `recovering` block nothing clears goes stale as any other does.
 */
export async function advanceSessionOutcomeDeliverableRepairs(
  access: SessionOutcomeDeliverableRepairAccess
): Promise<void> {
  const store = sessionOutcomeDeliverableRepairStore()
  const chain = access.read()
  const set = chain.outcomeSet
  // A sealed run is final; a workflow run's holds are not repaired (`...-repair-hold.ts`).
  if (!store || !set || set.completion || set.workflow) {
    return
  }
  for (const outcome of set.outcomes) {
    if (
      outcome.status !== 'blocked' ||
      outcome.block?.code !== SESSION_OUTCOME_DELIVERABLE_REPAIR_CODE
    ) {
      continue
    }
    try {
      await advanceRepair(access, store, chain, outcome)
    } catch (error) {
      console.warn('[outcomes] missing files not handed back yet', chain.id, outcome.id, error)
    }
  }
}
