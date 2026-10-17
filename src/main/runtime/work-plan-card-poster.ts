import type { SessionChain } from '../../shared/session-chain-types'
import {
  workPlanCardPost,
  type WorkPlanCardNote,
  type WorkPlanTaskEvidenceRow,
  type WorkPlanCardRecommendation
} from '../../shared/work-plan-card-post'
import type { SessionChainPersistence } from '../persistence/loading-store/session-chain-persistence'

/** The same resolved URL and bearer used by backoffice-review-note.ts. */
export type WorkPlanCardAccess = { baseUrl: string; bearer: string }
export type WorkPlanCardPostResult =
  | { posted: true; noteId: string }
  | { posted: false; reason: string }
type HubResult<T> = { ok: true; data: T } | { ok: false; reason: string }

export type WorkPlanCardPosterDeps = {
  /** Host snapshot allows standalone work to return without invoking any dependency. */
  chain: SessionChain
  loadChain: (chainId: string) => SessionChain | undefined
  persistence: Pick<SessionChainPersistence, 'replaceSessionChainOutcomesAndFlush'>
  postNote: (
    access: WorkPlanCardAccess,
    taskId: string,
    note: WorkPlanCardNote
  ) => Promise<HubResult<{ id: string }>>
  postEvidence: (
    access: WorkPlanCardAccess,
    taskId: string,
    evidence: WorkPlanTaskEvidenceRow
  ) => Promise<HubResult<unknown>>
  /** Bound adapter to create-task-submit.ts's existing attachSessionToTask. */
  attachSessionToTask: (
    taskId: string
  ) => Promise<{ attached: boolean; errorCode?: string; errorMessage?: string }>
  now: () => number
  recommendation?: WorkPlanCardRecommendation
}

const pending = new WeakMap<
  WorkPlanCardPosterDeps['persistence'],
  Map<string, Promise<WorkPlanCardPostResult>>
>()

function postFor(
  chain: SessionChain,
  outcomeId: string,
  recommendation?: WorkPlanCardRecommendation
) {
  const outcome = chain.outcomeSet?.outcomes.find((entry) => entry.id === outcomeId)
  return outcome && chain.outcomeSet
    ? workPlanCardPost(
        { ...chain, outcomeSet: { ...chain.outcomeSet, outcomes: [outcome] } },
        recommendation
      )
    : null
}

async function post(
  access: WorkPlanCardAccess,
  chainId: string,
  outcomeId: string,
  deps: WorkPlanCardPosterDeps
): Promise<WorkPlanCardPostResult> {
  const chain = deps.loadChain(chainId)
  const outcome = chain?.outcomeSet?.outcomes.find((entry) => entry.id === outcomeId)
  if (!chain || !outcome) {
    return { posted: false, reason: 'outcome-not-found' }
  }
  const payload = postFor(chain, outcomeId, deps.recommendation)
  if (!payload) {
    return { posted: false, reason: 'standalone' }
  }
  if (
    outcome.taskRef?.postedNoteId &&
    (outcome.taskRef.postedRevision === undefined ||
      outcome.taskRef.postedRevision === outcome.revision)
  ) {
    return { posted: false, reason: 'already-posted' }
  }
  if (
    chain.outcomeSet?.continuation.taskId &&
    chain.outcomeSet.continuation.taskId !== payload.taskId
  ) {
    return { posted: false, reason: 'task-binding-conflict' }
  }
  const attached = await deps.attachSessionToTask(payload.taskId)
  if (!attached.attached) {
    return {
      posted: false,
      reason: attached.errorMessage ?? attached.errorCode ?? 'session-not-attached'
    }
  }
  const result = await deps.postNote(access, payload.taskId, payload.note)
  if (!result.ok) {
    return { posted: false, reason: result.reason }
  }
  const noteId = result.data.id
  if (!noteId) {
    return { posted: false, reason: 'note-id-missing' }
  }

  // Flush the accepted note before further HTTP calls, and merge into the latest host record.
  const current = deps.loadChain(chainId)
  const set = current?.outcomeSet
  const latest = set?.outcomes.find((entry) => entry.id === outcomeId)
  if (
    !current ||
    !set ||
    !latest ||
    latest.revision !== outcome.revision ||
    (latest.taskRef?.taskId ?? set.continuation.taskId) !== payload.taskId
  ) {
    throw new Error(`Accepted note ${noteId}; outcome changed before persistence.`)
  }
  const at = deps.now()
  deps.persistence.replaceSessionChainOutcomesAndFlush(
    {
      ...current,
      outcomeSet: {
        ...set,
        outcomes: set.outcomes.map((entry) =>
          entry.id !== outcomeId
            ? entry
            : {
                ...entry,
                taskRef: {
                  ...(entry.taskRef ?? { taskId: payload.taskId, attachedAt: at }),
                  postedNoteId: noteId,
                  postedAt: at,
                  postedRevision: outcome.revision
                }
              }
        )
      }
    },
    set.revision
  )
  for (const evidence of payload.evidence) {
    const stored = await deps.postEvidence(access, payload.taskId, evidence)
    if (!stored.ok) {
      return { posted: false, reason: stored.reason }
    }
  }
  return { posted: true, noteId }
}

export async function postWorkPlanToCard(
  access: WorkPlanCardAccess,
  chainId: string,
  outcomeId: string,
  deps: WorkPlanCardPosterDeps
): Promise<{ posted: true; noteId: string } | { posted: false; reason: string }> {
  if (deps.chain.id !== chainId) {
    return { posted: false, reason: 'chain-id-mismatch' }
  }
  if (!deps.chain.outcomeSet?.outcomes.some((entry) => entry.id === outcomeId)) {
    return { posted: false, reason: 'outcome-not-found' }
  }
  if (!postFor(deps.chain, outcomeId, deps.recommendation)) {
    return { posted: false, reason: 'standalone' }
  }
  const queue = pending.get(deps.persistence) ?? new Map<string, Promise<WorkPlanCardPostResult>>()
  pending.set(deps.persistence, queue)
  const prior = queue.get(chainId)
  const operation = (async (): Promise<WorkPlanCardPostResult> => {
    await prior
    try {
      return await post(access, chainId, outcomeId, deps)
    } catch (error) {
      return { posted: false, reason: error instanceof Error ? error.message : String(error) }
    }
  })()
  queue.set(chainId, operation)
  try {
    return await operation
  } finally {
    if (queue.get(chainId) === operation) {
      queue.delete(chainId)
    }
  }
}
