import type { ConsoleWorkflowResult } from '../../shared/console-workflow-types'
import type { HandoffArtifactReview } from '../../shared/handoff-artifact-review'
import { failure } from './console-workflow-refusal'

/**
 * The two effects a page-review handoff has beside the hub request, around the one send path
 * every delivery takes (renderer and host alike go through `consoleHandoffClient`):
 *
 * - before: the recipient is made a named reviewer of the page (`artifact-review-grant.ts`), so
 *   they can decide on it signed in. Idempotent, so a replay of an unconfirmed send is harmless.
 * - after: the thread is remembered, so this desktop can post the page's decision back into it
 *   (`handoff-artifact-review-watch.ts`).
 *
 * Installed by the main process once the artifact service exists; a send carrying a page with
 * nothing installed is refused rather than delivered as a review nobody can decide.
 */

export type ArtifactReviewGrantResult =
  | { ok: true }
  /** `permanent`: sending again cannot help (not the owner, no local source, bad page). */
  | { ok: false; message: string; permanent: boolean }

export type HandoffArtifactReviewSendHooks = {
  grant: (input: {
    review: HandoffArtifactReview
    reviewer: string
  }) => Promise<ArtifactReviewGrantResult>
  sent: (input: { threadId: string; review: HandoffArtifactReview; recipient: string }) => void
}

let hooks: HandoffArtifactReviewSendHooks | null = null

export function installHandoffArtifactReviewSend(
  value: HandoffArtifactReviewSendHooks | null
): void {
  hooks = value
}

/** A refusal to return instead of sending, or null when the send may go ahead. */
export async function prepareArtifactReviewSend<T>(input: {
  artifactReview?: HandoffArtifactReview
  recipient: string
}): Promise<ConsoleWorkflowResult<T> | null> {
  if (!input.artifactReview) {
    return null
  }
  if (!hooks) {
    return failure(
      'artifact_review_unavailable',
      'Page reviews are not available on this computer, so the page was not sent for review.',
      422
    )
  }
  let result: ArtifactReviewGrantResult
  try {
    result = await hooks.grant({ review: input.artifactReview, reviewer: input.recipient })
  } catch (error) {
    result = {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      permanent: false
    }
  }
  if (result.ok) {
    return null
  }
  // Why the status: a permanent refusal is a 4xx (the send is failed, not replayed); anything
  // else carries none, so the delivery treats it as unconfirmed and tries again later.
  return failure('artifact_review_grant_failed', result.message, result.permanent ? 422 : undefined)
}

export function noteArtifactReviewSent(
  input: { artifactReview?: HandoffArtifactReview; recipient: string },
  result: ConsoleWorkflowResult<{ thread_id?: string }>
): void {
  if (!input.artifactReview || !result.ok || !result.data.thread_id || !hooks) {
    return
  }
  try {
    hooks.sent({
      threadId: result.data.thread_id,
      review: input.artifactReview,
      recipient: input.recipient
    })
  } catch {
    // Why swallowed: the request already left; failing to remember it must not report a failed send.
  }
}

/** `send` with both effects around it: the grant before the request, the record after it. */
export function withArtifactReviewSend<
  Input extends { artifactReview?: HandoffArtifactReview; recipient: string },
  Receipt extends { thread_id?: string }
>(
  send: (input: Input) => Promise<ConsoleWorkflowResult<Receipt>>
): (input: Input) => Promise<ConsoleWorkflowResult<Receipt>> {
  return async (input) => {
    const refused = await prepareArtifactReviewSend<Receipt>(input)
    if (refused) {
      return refused
    }
    const result = await send(input)
    noteArtifactReviewSent(input, result)
    return result
  }
}
