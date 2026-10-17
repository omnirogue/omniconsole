import type { AppState } from '@/store'
import type { HostedReviewInfo, HostedReviewState } from '../../../shared/hosted-review'
import type { CheckStatus } from '../../../shared/github/pull-request-types'
import type { SessionProjectThread } from './session-project-threads'
import { sessionHostedReviewDetailsLookup } from './session-project-hosted-review'

export type SessionProjectThreadOutput =
  | { kind: 'review'; label: string; url: string; state: HostedReviewState; checks: CheckStatus }
  | { kind: 'issue'; label: string }

export type SessionProjectOutputsState = Pick<
  AppState,
  'worktreesByRepo' | 'repos' | 'hostedReviewCache' | 'prCache' | 'settings'
>

/** "#12" on GitHub-like hosts, "!12" where the host calls it a merge request. */
function hostedReviewLabel(review: HostedReviewInfo): string {
  return `${review.provider === 'gitlab' ? '!' : '#'}${review.number}`
}

/**
 * What a thread has produced so far, as the page's chips: its pull or merge request from the
 * provider-neutral caches the dashboard cards read, and the issue it serves. A folder workspace
 * has no review.
 */
export function sessionProjectThreadOutputsLookup(
  state: SessionProjectOutputsState
): (thread: SessionProjectThread) => SessionProjectThreadOutput[] {
  const reviewFor = sessionHostedReviewDetailsLookup(state)
  return (thread) => {
    const outputs: SessionProjectThreadOutput[] = []
    const review = reviewFor(thread.row)
    if (review) {
      outputs.push({
        kind: 'review',
        label: hostedReviewLabel(review),
        url: review.url,
        state: review.state,
        checks: review.status
      })
    }
    if (thread.jira) {
      outputs.push({ kind: 'issue', label: thread.jira.issue_key })
    }
    return outputs
  }
}

/** The follow-up Fix CI sends: the review to fix; the agent reads its failing checks itself. */
export function sessionProjectFixCiPrompt(review: { label: string; url: string }): string {
  return `CI is failing on ${review.label} (${review.url}). Read its failing checks, fix the cause, and push the fix to the same branch.`
}
