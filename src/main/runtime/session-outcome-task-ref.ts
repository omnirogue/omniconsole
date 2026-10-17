import type { SessionOutcomeTaskRef } from '../../shared/session-outcome-types'
import { isBoardTaskId } from '../../shared/board-task-id'
import type { SessionChain } from '../../shared/session-chain-types'
import {
  postWorkPlanToCard,
  type WorkPlanCardAccess,
  type WorkPlanCardPosterDeps
} from './work-plan-card-poster'

export type OutcomeTaskAttachmentAccess = {
  source: 'user' | 'ai'
  taskRef?: SessionOutcomeTaskRef
  loadChain: WorkPlanCardPosterDeps['loadChain']
  persistence: WorkPlanCardPosterDeps['persistence']
  cardAccess: WorkPlanCardAccess
  poster: Omit<WorkPlanCardPosterDeps, 'chain' | 'loadChain' | 'persistence'>
}

/** Filing changes only taskRef; the caller serializes this operation with execution ticks. */
export async function attachOutcomeToTask(
  access: OutcomeTaskAttachmentAccess,
  chainId: string,
  outcomeId: string,
  taskId: string
): Promise<SessionChain> {
  if (access.source !== 'user') {
    throw new Error('Task filing requires source user.')
  }
  if (!isBoardTaskId(taskId)) {
    throw new Error('A board card id looks like btk_….')
  }
  const chain = access.loadChain(chainId)
  const set = chain?.outcomeSet
  const outcome = set?.outcomes.find((entry) => entry.id === outcomeId)
  if (!chain || !set || !outcome) {
    throw new Error('No committed outcome was found.')
  }
  if (set.continuation.taskId && set.continuation.taskId !== taskId) {
    throw new Error(
      'This work is already executing a different card. Detach it before filing here.'
    )
  }
  const previous = outcome.taskRef
  const taskRef =
    previous?.taskId === taskId
      ? previous
      : {
          taskId,
          attachedAt: access.taskRef?.attachedAt ?? access.poster.now(),
          ...(access.taskRef?.attachedBy ? { attachedBy: access.taskRef.attachedBy } : {})
        }
  const filed = access.persistence.replaceSessionChainOutcomesAndFlush(
    {
      ...chain,
      outcomeSet: {
        ...set,
        outcomes: set.outcomes.map((entry) =>
          entry.id === outcomeId ? { ...entry, taskRef } : entry
        )
      }
    },
    set.revision
  )
  const result = await postWorkPlanToCard(access.cardAccess, chainId, outcomeId, {
    ...access.poster,
    chain: filed,
    loadChain: access.loadChain,
    persistence: access.persistence
  })
  if (!result.posted && result.reason !== 'already-posted') {
    const current = access.loadChain(chainId)
    if (!current?.outcomeSet || current.outcomeSet.revision !== set.revision) {
      throw new Error(`${result.reason}; outcome changed before task filing could be rolled back.`)
    }
    const accepted = current.outcomeSet.outcomes.find((entry) => entry.id === outcomeId)?.taskRef
    // A later evidence refusal cannot undo an accepted note or erase its replay receipt.
    if (accepted?.postedNoteId && accepted.postedRevision === outcome.revision) {
      throw new Error(result.reason)
    }
    access.persistence.replaceSessionChainOutcomesAndFlush(
      {
        ...current,
        outcomeSet: {
          ...current.outcomeSet,
          outcomes: current.outcomeSet.outcomes.map((entry) => {
            if (entry.id !== outcomeId) {
              return entry
            }
            const { taskRef: _taskRef, ...rest } = entry
            return previous ? { ...rest, taskRef: previous } : rest
          })
        }
      },
      set.revision
    )
    throw new Error(result.reason)
  }
  return access.loadChain(chainId)!
}
