/** Facts a card-bound Build + Review pipeline projects to its omnios card (see backoffice-review-note.ts). */
export type BuildReviewNoteEvent =
  | 'build_reported'
  | 'review_verdict'
  | 'review_approved'
  | 'review_changes_requested'
  | 'review_limit_reached'

export type BuildReviewNoteInput = {
  hubTaskId: string
  pipelineId: string
  runId: string | null
  round: number
  event: BuildReviewNoteEvent
  /** Agent/model description of the worker the fact is about. */
  worker?: string
  verdict?: 'APPROVE' | 'REQUEST_CHANGES'
  outcome?: 'succeeded' | 'failed'
  reportPath?: string | null
  filesModified?: string[]
  /** Short free text (findings excerpt, reviewer count). */
  detail?: string
}

export type BuildReviewNoteResult = { ok: true; noteId: string } | { ok: false; message: string }

export type BuildReviewNoteReporter = (
  input: BuildReviewNoteInput
) => Promise<BuildReviewNoteResult>
