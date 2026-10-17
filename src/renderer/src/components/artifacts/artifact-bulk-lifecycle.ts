import type { ArtifactListItem } from '../../../../shared/artifacts'
import {
  isArtifactCollectAsk,
  type ArtifactLifecycleRequest
} from '../../../../shared/artifact-review'
import { translate } from '@/i18n/i18n'
import { artifactCloseRequest, artifactSupersedeRequest } from './artifact-lifecycle-actions'
import {
  artifactCurrentDecision,
  artifactRevision,
  isArtifactClosed,
  isArtifactReviewPage
} from './artifact-lifecycle-model'

export type ArtifactBulkAction = 'done' | 'no_action' | 'supersede'

export type ArtifactBulkSkipReason =
  | 'not_review'
  | 'already_closed'
  | 'not_approved'
  | 'already_superseded'
  | 'is_successor'
  | 'no_revision'
  | 'study'

export type ArtifactBulkPlan = {
  action: ArtifactBulkAction
  target: string | null
  acted: { item: ArtifactListItem; request: ArtifactLifecycleRequest }[]
  skipped: { item: ArtifactListItem; reason: ArtifactBulkSkipReason }[]
}

export const ARTIFACT_BULK_MAX_IN_FLIGHT = 4

function skipReason(
  action: ArtifactBulkAction,
  item: ArtifactListItem,
  target: string | null
): ArtifactBulkSkipReason | null {
  if (artifactRevision(item) === null) {
    return 'no_revision'
  }
  // Why: a study that anyone answered stays closed (its answers were shown), so it closes on its own.
  const study = item.artifact.review?.type === 'study'
  if (action === 'supersede') {
    if (item.artifact.supersededBy) {
      return 'already_superseded'
    }
    return item.artifact.slug === target ? 'is_successor' : study ? 'study' : null
  }
  if (!isArtifactReviewPage(item)) {
    return 'not_review'
  }
  if (isArtifactClosed(item)) {
    return 'already_closed'
  }
  if (study) {
    return 'study'
  }
  return action === 'done' &&
    !isArtifactCollectAsk(item.artifact.review) &&
    artifactCurrentDecision(item)?.decision !== 'approved'
    ? 'not_approved'
    : null
}

/** Splits the selection into rows the action applies to and rows it skips, with the reason. */
export function planArtifactBulkAction(
  action: ArtifactBulkAction,
  items: readonly ArtifactListItem[],
  target: string | null = null
): ArtifactBulkPlan {
  const plan: ArtifactBulkPlan = { action, target, acted: [], skipped: [] }
  for (const item of items) {
    const reason = skipReason(action, item, target)
    const request =
      reason !== null
        ? null
        : action === 'supersede'
          ? artifactSupersedeRequest(item, target ?? '', { bulk: true })
          : artifactCloseRequest(item, action, { bulk: true })
    if (request) {
      plan.acted.push({ item, request })
    } else {
      plan.skipped.push({ item, reason: reason ?? 'is_successor' })
    }
  }
  return plan
}

export function artifactBulkSkipReasonLabel(reason: ArtifactBulkSkipReason): string {
  switch (reason) {
    case 'not_review':
      return translate('auto.components.artifacts.bulk.skipNotReview', 'not a review page')
    case 'already_closed':
      return translate('auto.components.artifacts.bulk.skipClosed', 'already closed')
    case 'not_approved':
      return translate('auto.components.artifacts.bulk.skipNotApproved', 'not approved')
    case 'already_superseded':
      return translate('auto.components.artifacts.bulk.skipSuperseded', 'already superseded')
    case 'is_successor':
      return translate('auto.components.artifacts.bulk.skipIsSuccessor', 'is the successor')
    case 'no_revision':
      return translate('auto.components.artifacts.bulk.skipNoRevision', 'no revision reported')
    case 'study':
      return translate('auto.components.artifacts.bulk.skipStudy', 'a study (close it on its own)')
  }
}

export function artifactBulkActionLabel(action: ArtifactBulkAction): string {
  switch (action) {
    case 'done':
      return translate('auto.components.artifacts.bulk.markDone', 'Mark done')
    case 'no_action':
      return translate('auto.components.artifacts.bulk.noAction', 'No action')
    case 'supersede':
      return translate('auto.components.artifacts.bulk.supersede', 'Superseded by…')
  }
}

/** "2 not a review page, 1 not approved" — counts per reason, in first-seen order. */
export function artifactBulkSkipSummary(skipped: ArtifactBulkPlan['skipped']): string {
  const counts = new Map<ArtifactBulkSkipReason, number>()
  for (const { reason } of skipped) {
    counts.set(reason, (counts.get(reason) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([reason, count]) => `${count} ${artifactBulkSkipReasonLabel(reason)}`)
    .join(', ')
}

export function artifactBulkConfirmation(
  plan: ArtifactBulkPlan,
  targetTitle: string | null
): { title: string; description: string; confirmLabel: string } {
  const count = plan.acted.length
  const lines = [
    plan.action === 'supersede'
      ? translate(
          'auto.components.artifacts.bulk.confirmSupersede',
          '{{total}} page(s) will be marked superseded by “{{target}}”.',
          { total: count, target: targetTitle ?? '' }
        )
      : translate(
          'auto.components.artifacts.bulk.confirmClose',
          '{{total}} page(s) will be closed as “{{action}}”.',
          { total: count, action: artifactBulkActionLabel(plan.action) }
        )
  ]
  if (plan.skipped.length > 0) {
    lines.push(
      translate(
        'auto.components.artifacts.bulk.confirmSkipped',
        '{{total}} skipped: {{reasons}}.',
        {
          total: plan.skipped.length,
          reasons: artifactBulkSkipSummary(plan.skipped)
        }
      )
    )
  }
  return {
    title: translate(
      'auto.components.artifacts.bulk.confirmTitle',
      '{{action}} for {{total}} page(s)?',
      {
        action: artifactBulkActionLabel(plan.action).replace('…', ''),
        total: count
      }
    ),
    description: lines.join('\n'),
    confirmLabel: artifactBulkActionLabel(plan.action).replace('…', '')
  }
}

/** Runs each task once, at most `limit` at a time, in order; never rejects. */
export async function runArtifactLifecycleQueue<T>(
  tasks: readonly T[],
  run: (task: T) => Promise<void>,
  limit = ARTIFACT_BULK_MAX_IN_FLIGHT
): Promise<void> {
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < tasks.length) {
      const task = tasks[next]
      next += 1
      try {
        await run(task)
      } catch {
        // Why: each task reports its own outcome; one failure must not stop the rest.
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker))
}

export type ArtifactBulkOutcome = {
  changed: { slug: string; name: string; undo: ArtifactLifecycleRequest | null }[]
  conflicts: string[]
  failures: string[]
}

export function artifactBulkOutcomeSummary(
  outcome: ArtifactBulkOutcome,
  skipped: readonly string[]
): string {
  const parts = [
    translate('auto.components.artifacts.bulk.changed', '{{total}} changed', {
      total: outcome.changed.length
    })
  ]
  if (skipped.length > 0) {
    parts.push(
      translate('auto.components.artifacts.bulk.skippedNames', '{{total}} skipped: {{names}}', {
        total: skipped.length,
        names: skipped.join(', ')
      })
    )
  }
  if (outcome.conflicts.length > 0) {
    parts.push(
      translate(
        'auto.components.artifacts.bulk.conflicts',
        '{{total}} changed since you selected them: {{names}}',
        { total: outcome.conflicts.length, names: outcome.conflicts.join(', ') }
      )
    )
  }
  if (outcome.failures.length > 0) {
    parts.push(
      translate('auto.components.artifacts.bulk.failures', '{{total}} failed: {{names}}', {
        total: outcome.failures.length,
        names: outcome.failures.join(', ')
      })
    )
  }
  return parts.join(' · ')
}
