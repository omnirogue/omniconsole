import { ARTIFACT_LIFECYCLE_NOTE_MAX_CHARS, type ArtifactReviewProgress } from './artifact-review'
import { ARTIFACT_APPROVAL_SCOPE_LINE } from './artifact-review-decision-message'

export type ArtifactResponsesMessageInput = {
  slug: string
  title: string
  shareUrl: string
  progress: ArtifactReviewProgress
  /** A study: its summary never goes on the page while it is open. */
  study: boolean
  /** The session was asleep and this message woke it. */
  woke?: boolean
}

/** "2 of 3 answered", or "the due time passed (4 answered)" when the due time made it ready. */
export function artifactResponsesCount(progress: ArtifactReviewProgress): string {
  const answered =
    progress.of === null
      ? `${progress.submitted} answered`
      : `${progress.submitted} of ${progress.of} answered`
  const aside = progress.setAside > 0 ? `, ${progress.setAside} set aside` : ''
  return progress.reason === 'due'
    ? `the due time passed (${answered}${aside})`
    : `${answered}${aside}`
}

/** The due time passed with no answer: nothing to sum up, and no conclusion to make up. */
export const ARTIFACT_NO_RESPONSES_STEP =
  'Nobody answered, so there is nothing to sum up or conclude. Do now: tell the owner; waiting longer, reminding people or closing the ask is theirs.'

/**
 * Where the summary goes. A review's answers are open to the people it asks, so one comment on the
 * page; the owner's comments on an open study reach people who haven't answered, so never there.
 */
export function artifactResponsesSummaryStep(slug: string, study: boolean): string {
  const read = `read the answers (omni artifacts status ${slug} --json, the "responses" field)`
  return study
    ? `Do now: ${read} and sum up their common themes and disagreements in your reply to the owner. Never comment on the page while the study is open: people who haven't answered would see it.`
    : `Do now: ${read} and sum up their common themes and disagreements in one comment on the page (OmniConsole artifact_comment; without that tool, in your reply to the owner).`
}

/** The close is the owner's unless the session was told to act on the answers. */
export function artifactResponsesCloseStep(slug: string, revision: number): string {
  return `If you were told to act on the answers and the ask is still open, act, then close it with the conclusion: omni artifacts close ${slug} --done --revision ${revision} --note "<conclusion, at most ${ARTIFACT_LIFECYCLE_NOTE_MAX_CHARS} characters>". Otherwise the decision and the close are the owner's.`
}

/** The message a review or study delivers to the conversation that asked once its answers are in. */
export function artifactResponsesInMessage(input: ArtifactResponsesMessageInput): string {
  const { progress, slug } = input
  const none = progress.submitted === 0
  const lines = [
    `[OmniOS responses] ${none ? 'No responses' : 'Responses in'}: ${artifactResponsesCount(progress)} on revision ${progress.revision} of "${input.title || slug}"`,
    input.shareUrl,
    'This is not an approval: nobody decided anything, and the ask stays open until it is closed.',
    ...(none
      ? [ARTIFACT_NO_RESPONSES_STEP]
      : [
          artifactResponsesSummaryStep(slug, input.study),
          artifactResponsesCloseStep(slug, progress.revision)
        ]),
    ARTIFACT_APPROVAL_SCOPE_LINE
  ]
  if (input.woke) {
    lines.push(
      'You were asleep waiting for these answers; this message woke the same conversation.'
    )
  }
  return lines.join('\n')
}
