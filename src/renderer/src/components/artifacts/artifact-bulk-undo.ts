import type { ArtifactListItem } from '../../../../shared/artifacts'
import type { ArtifactLifecycleRequest } from '../../../../shared/artifact-review'
import { translate } from '@/i18n/i18n'
import { runArtifactLifecycleQueue, type ArtifactBulkOutcome } from './artifact-bulk-lifecycle'
import { isArtifactLifecycleConflict } from './artifact-lifecycle-actions'
import type { ArtifactLifecycleResult } from './artifact-lifecycle-client'

/**
 * Sends the exact inverse for each changed row; 409s are reported, never retried. `send` is the
 * page's gated call, so an undo shares the in-flight cap with every other lifecycle operation.
 */
export async function undoArtifactBulk({
  outcome,
  before,
  send,
  markBusy,
  restoreAttention
}: {
  outcome: ArtifactBulkOutcome
  before: ReadonlyMap<string, ArtifactListItem>
  send: (
    item: ArtifactListItem,
    request: ArtifactLifecycleRequest
  ) => Promise<ArtifactLifecycleResult>
  markBusy: (slug: string, on: boolean) => void
  restoreAttention: (item: ArtifactListItem) => void
}): Promise<{ message: string; failed: boolean }> {
  const conflicts: string[] = []
  const failures: string[] = []
  let undone = 0
  await runArtifactLifecycleQueue(outcome.changed, async (change) => {
    const item = before.get(change.slug)
    if (!item || !change.undo) {
      return
    }
    markBusy(change.slug, true)
    try {
      const result = await send(item, change.undo)
      if (result.ok) {
        undone += 1
        restoreAttention(item)
      } else if (isArtifactLifecycleConflict(result.code)) {
        conflicts.push(change.name)
      } else {
        failures.push(change.name)
      }
    } finally {
      markBusy(change.slug, false)
    }
  })
  const message = [
    translate('auto.components.artifacts.bulk.undone', '{{total}} undone', { total: undone }),
    ...(conflicts.length > 0
      ? [
          translate(
            'auto.components.artifacts.bulk.undoConflicts',
            '{{total}} changed since and were left as they are: {{names}}',
            { total: conflicts.length, names: conflicts.join(', ') }
          )
        ]
      : []),
    ...(failures.length > 0
      ? [
          translate('auto.components.artifacts.bulk.failures', '{{total}} failed: {{names}}', {
            total: failures.length,
            names: failures.join(', ')
          })
        ]
      : [])
  ].join(' · ')
  return { message, failed: conflicts.length + failures.length > 0 }
}
