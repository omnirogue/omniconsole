import type { NextOutcomeReviewPlan } from './next-outcome-review-plan'
import type { NextOutcomeTeamPlan, SessionChainTeamPlanning } from './next-outcome-team-plan-schema'
import type { SessionFinishChoice } from './session-finish-intent'
import type { SessionOutcomeTaskRef } from './session-outcome-task-ref'
import type { SessionOutcomeDefinition } from './session-outcome-types'

export type SessionOutcomeCommit = {
  /**
   * How this session finishes. Absent CARRIES the finish the set already had: an ordinary plan
   * commit is not a change of mind about finishing, and must not silently un-finish a session.
   */
  sessionFinish?: SessionFinishChoice
  /**
   * Take the finish intent off this set. The person removed Done before it executed, so the
   * session no longer ends itself; said as its own signal because leaving `sessionFinish` out
   * means "keep the one you have" for every other commit.
   */
  clearSessionFinish?: true
  reviewPlans?: NextOutcomeReviewPlan[]
  expectedAttachedTask?: { taskId: string; sessionId: string }
  expectedExecutionRuntimeId?: string
  expectedSourcePrompt?: string
  expectedRevision: number
  outcomes: SessionOutcomeDefinition[]
  removals?: { outcomeId: string; reason: string }[]
  /** Files every outcome of this commit under a board card; absent leaves the filing as it was. */
  taskRef?: SessionOutcomeTaskRef
  /**
   * This commit is a new plan version for the same outcome: what the old plan had not finished is
   * retired rather than left to run or to block. The outcome's identity, and its revision, stand.
   */
  supersede?: { reason: string }
  /**
   * The steps the chain already carries that THIS plan still draws, so a supersede retires only
   * what the new plan dropped.
   *
   * "Retire everything unfinished" is right for a change of strategy and wrong for a plan that
   * merely removed one stage or one person: the stages beside it are unchanged, so the lowering
   * does not re-compile them (`newWorkPlanSteps` returns only what changed) and nothing else
   * would keep them — removing one queued stage retired the queued stage next to it, which then
   * vanished from Up next without ever running. Only a caller that lowered a plan can say which
   * steps it still draws; absent means it cannot, and every unfinished step is retired as before.
   * A step named here keeps its identity, its status and its place, and is re-stamped with the new
   * plan version, because the version that draws it is the version it belongs to.
   */
  drawsSteps?: string[]
  planVersion?: number
  source: 'user' | 'ai'
  /** Agent-planned team; the host compiles it and refuses it without the user's launch consent. */
  team?: NextOutcomeTeamPlan
  /** Written only by the host after it verified consent; never accepted from a caller. */
  teamPlanning?: SessionChainTeamPlanning
}
