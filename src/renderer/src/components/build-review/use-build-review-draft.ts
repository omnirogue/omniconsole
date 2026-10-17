import { useEffect, useState } from 'react'
import type { BuildReviewDraft } from '../../../../shared/build-review-draft'
import {
  BUILD_REVIEW_DEFAULT_BUILDER,
  BUILD_REVIEW_DEFAULT_REVIEWERS
} from '../../../../shared/build-review-pipeline'
import { WORKFLOW_DEFAULT_RUNS_ON } from '../../../../shared/local-workflow-placement'
import type { WorkflowRunOnChoice } from '../local-workflows/workflow-run-on-hosts'

/**
 * The setup form's state, seeded from a saved draft. With `lockWorktree` the workspace is always
 * `initialWorktree`: a conversation tab belongs to one workspace, and a draft saved while the tab
 * still offered a picker must not send the run somewhere the form no longer shows.
 */
export function useBuildReviewDraft(
  initialWorktree: string,
  initialObjective: string,
  initialDraft?: BuildReviewDraft,
  onDraftChange?: (draft: BuildReviewDraft) => void,
  lockWorktree = false
) {
  const [pickedWorktree, setWorktree] = useState(initialDraft?.worktree ?? initialWorktree)
  const worktree = lockWorktree ? initialWorktree : pickedWorktree
  const [objective, setObjective] = useState(initialDraft?.objective ?? initialObjective)
  const [reviewFocus, setReviewFocus] = useState(initialDraft?.reviewFocus ?? '')
  const [hubTaskId, setHubTaskId] = useState(initialDraft?.hubTaskId ?? '')
  const [builder, setBuilder] = useState(
    initialDraft?.builder ?? { ...BUILD_REVIEW_DEFAULT_BUILDER }
  )
  const [reviewers, setReviewers] = useState<BuildReviewDraft['reviewers']>(
    initialDraft?.reviewers ??
      BUILD_REVIEW_DEFAULT_REVIEWERS.map((choice, id) => ({
        id,
        choice: { ...choice },
        seeded: true
      }))
  )
  const [maxReviewRounds, setMaxReviewRounds] = useState(initialDraft?.maxReviewRounds ?? 3)
  const [runOn, setRunOn] = useState<WorkflowRunOnChoice>({
    runsOn: initialDraft?.runsOn ?? WORKFLOW_DEFAULT_RUNS_ON,
    ...(initialDraft?.runsOnHost ? { runsOnHost: initialDraft.runsOnHost } : {}),
    ...(initialDraft?.runsOnHostId ? { runsOnHostId: initialDraft.runsOnHostId } : {})
  })
  useEffect(() => {
    onDraftChange?.({
      worktree,
      objective,
      reviewFocus,
      hubTaskId,
      builder,
      reviewers,
      maxReviewRounds,
      ...runOn
    })
  }, [
    worktree,
    objective,
    reviewFocus,
    hubTaskId,
    builder,
    reviewers,
    maxReviewRounds,
    runOn,
    onDraftChange
  ])
  return {
    worktree,
    setWorktree,
    objective,
    setObjective,
    reviewFocus,
    setReviewFocus,
    hubTaskId,
    setHubTaskId,
    builder,
    setBuilder,
    reviewers,
    setReviewers,
    maxReviewRounds,
    setMaxReviewRounds,
    runOn,
    setRunOn
  }
}
