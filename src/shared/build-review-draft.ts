import type { BuildReviewAgentChoice } from './build-review-pipeline'
import type { WorkflowRunsOn } from './local-workflow-placement'

export type BuildReviewDraft = {
  worktree: string
  objective: string
  reviewFocus: string
  hubTaskId: string
  builder: BuildReviewAgentChoice
  reviewers: { id: number; choice: BuildReviewAgentChoice; chosen?: boolean; seeded?: boolean }[]
  maxReviewRounds: number
  /** Absent on drafts saved before placement was a choice; the form shows the preset default. */
  runsOn?: WorkflowRunsOn
  /** "Run on: <host>" and its execution host id; absent: the fleet chooses, or this computer. */
  runsOnHost?: string
  runsOnHostId?: string
}
