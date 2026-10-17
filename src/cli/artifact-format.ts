import {
  artifactLifecycleSnapshot,
  isArtifactCollectAsk,
  type ArtifactReviewDecision,
  type ArtifactReviewStatus
} from '../shared/artifact-review'
import type { ArtifactListItem, ArtifactListPage } from '../shared/artifacts'
import {
  artifactSessionSleepLine,
  type ArtifactSessionSleepNotice
} from '../shared/artifact-review-sleep'
import {
  ARTIFACT_NO_RESPONSES_STEP,
  artifactResponsesCloseStep,
  artifactResponsesCount,
  artifactResponsesSummaryStep
} from '../shared/artifact-review-responses-message'
import { artifactReviewWaitStatus } from './artifact-review-status'

export const ARTIFACT_REVIEW_NEXT_STEP =
  'Open it signed in to OmniConsole to approve, request changes or reject; read the decision with `omni artifacts status <file>`.'

export const ARTIFACT_COLLECT_NEXT_STEP =
  "The people asked answer on the page; nobody approves it. Once the responses are in, `omni artifacts status <file>` says what to do with them; the decision and the close are the owner's unless you were told to act on the answers."

const MAX_EDITS_CHARS = 4_000

export function formatArtifactList(artifacts: readonly ArtifactListItem[]): string {
  if (artifacts.length === 0) {
    return 'No shared artifacts.'
  }
  return artifacts
    .map(({ artifact, shareUrl }) => {
      const name = artifact.title || artifact.originalFileName || artifact.slug
      return `${name}\n  id: ${artifact.slug}\n  updated: ${artifact.updatedAt}\n  url: ${shareUrl}`
    })
    .join('\n\n')
}

export function formatArtifactListPage(page: ArtifactListPage): string {
  const rows = formatArtifactList(page.artifacts)
  return page.nextCursor ? `${rows}\nMore artifacts: --cursor ${page.nextCursor}` : rows
}

export function formatArtifactShared(
  item: ArtifactListItem & { sessionSleep?: ArtifactSessionSleepNotice }
): string {
  const review = item.artifact.review
  // Why filtered: the hints come from the server and an older or newer one may shape them differently.
  const warnings = (Array.isArray(item.warnings) ? item.warnings : [])
    .filter((warning) => typeof warning?.hint === 'string' && warning.hint)
    .map((warning) => `warning: ${warning.hint}`)
  if (!review) {
    return [item.shareUrl, ...warnings].join('\n')
  }
  const collect = isArtifactCollectAsk(review)
  const sleep = artifactSessionSleepLine(item.sessionSleep, collect)
  return [
    item.shareUrl,
    `review: ${review.status}`,
    ...warnings,
    collect ? ARTIFACT_COLLECT_NEXT_STEP : ARTIFACT_REVIEW_NEXT_STEP,
    ...(sleep ? [sleep] : [])
  ].join('\n')
}

function formatEdits(edits: unknown): string {
  const json = JSON.stringify(edits) ?? String(edits)
  return json.length > MAX_EDITS_CHARS
    ? `${json.slice(0, MAX_EDITS_CHARS)}... (truncated; use --json for the full edits)`
    : json
}

function formatDecision(decision: ArtifactReviewDecision): string[] {
  const who = decision.by.name ? `${decision.by.name} <${decision.by.email}>` : decision.by.email
  return [
    `decision: ${decision.decision} by ${who} at ${decision.at}`,
    ...(decision.comment ? [`comment: ${decision.comment}`] : []),
    ...(decision.edits !== null && decision.edits !== undefined
      ? [`edits: ${formatEdits(decision.edits)}`]
      : [])
  ]
}

/** A review or study's answers; absent from a decision page and from an older server. */
function formatResponses(result: ArtifactReviewStatus, responsesIn: boolean): string[] {
  const progress = result.progress
  if (!progress) {
    return []
  }
  const slug = result.artifact.slug
  if (responsesIn) {
    const none = progress.submitted === 0
    const head = `responses: ${none ? 'none' : 'in'}, ${artifactResponsesCount(progress)}.`
    if (!none && result.blind) {
      return [`${head} You see them once you submit your own answers.`]
    }
    // Why the owner only: nobody else may close the ask, so nobody else is told how.
    if (!result.viewer.isOwner) {
      return [
        `${head} This is not an approval; the owner decides what happens next and closes the ask.`
      ]
    }
    if (none) {
      return [`${head} ${ARTIFACT_NO_RESPONSES_STEP}`]
    }
    return [
      `${head} This is not an approval: nobody decided anything.`,
      artifactResponsesSummaryStep(slug, result.artifact.review?.type === 'study'),
      artifactResponsesCloseStep(slug, progress.revision)
    ]
  }
  const open = progress.everyone && !progress.ready ? '; anyone may answer until the due time' : ''
  return [`responses: ${artifactResponsesCount(progress)}${open}`]
}

function formatLifecycle(result: ArtifactReviewStatus): string[] {
  const state = artifactLifecycleSnapshot(result)
  const lines: string[] = []
  if (state.lifecycle) {
    const how = state.lifecycle === 'done' ? 'done' : 'no action needed'
    lines.push(`closed: ${how}${state.closedAt ? ` at ${state.closedAt}` : ''}`)
    if (state.closedRef) {
      lines.push(`result: ${state.closedRef}`)
    }
  }
  if (state.supersededBy) {
    lines.push(
      `superseded by: ${state.supersededBy}${state.supersededAt ? ` at ${state.supersededAt}` : ''}`
    )
  }
  return lines
}

export function formatArtifactReviewStatus(result: ArtifactReviewStatus): string {
  // Why the human status only: `--json` keeps the server's `pending` with `progress.ready`.
  const responsesIn = artifactReviewWaitStatus(result) === 'responses_in'
  const lines = [
    `url: ${result.shareUrl}`,
    `revision: ${result.artifact.revision ?? 'unknown'}`,
    `status: ${responsesIn ? 'responses_in' : (result.status ?? 'no review requested')}`,
    ...formatLifecycle(result),
    ...formatResponses(result, responsesIn)
  ]
  if (result.artifact.review?.question) {
    lines.push(`question: ${result.artifact.review.question}`)
  }
  if (result.latest) {
    lines.push(...formatDecision(result.latest))
  } else if (result.decisions.length > 0) {
    lines.push(`no decision on this revision yet (${result.decisions.length} on earlier revisions)`)
  }
  return lines.join('\n')
}
