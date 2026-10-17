import { translate } from '@/i18n/i18n'
import { sessionFolderRowState, type SessionFolderTallyState } from './session-folder-rollup'
import type { SessionSidebarTreeRow } from './session-sidebar-group-model'

/**
 * The Status view's groups after Needs you, most active first. Can't see only shows when a
 * session's host is out of reach: an unknown state is never filed as done or stopped.
 */
export const SESSION_STATUS_LENS_BUCKETS = [
  'working',
  'waiting',
  'done',
  'stopped',
  'cantSee'
] as const
type StatusBucket = (typeof SESSION_STATUS_LENS_BUCKETS)[number]

function statusBucket(state: SessionFolderTallyState | null): StatusBucket {
  switch (state) {
    case 'working':
    case 'done':
    case 'stopped':
    case 'cantSee':
      return state
    // Why: an asking row is lifted into Needs you; one that is not, and an idle one, waits.
    case 'needsYou':
    case 'waiting':
    case null:
      return 'waiting'
  }
}

function statusLabel(bucket: StatusBucket): string {
  switch (bucket) {
    case 'working':
      return translate('conversations.groupBy.working', 'Working')
    case 'waiting':
      return translate('conversationFleet.waitingGroup', 'Waiting')
    case 'done':
      return translate('dashboardPopout.bucket.done', 'Done')
    case 'stopped':
      return translate('conversations.groupBy.stopped', 'Stopped')
    case 'cantSee':
      return translate('conversations.groupBy.cantSee', "Can't see")
  }
}

/** Status ignores folders: each row goes by what it is doing, wherever it is filed. */
export function sessionStatusLensClassifier(
  classificationOf: (row: SessionSidebarTreeRow) => string | undefined
) {
  return (row: SessionSidebarTreeRow) => {
    const bucket = statusBucket(sessionFolderRowState(row, classificationOf(row)))
    return {
      id: bucket,
      label: statusLabel(bucket),
      order: SESSION_STATUS_LENS_BUCKETS.indexOf(bucket)
    }
  }
}
