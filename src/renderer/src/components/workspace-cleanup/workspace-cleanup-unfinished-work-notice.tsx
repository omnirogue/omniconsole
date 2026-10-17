import { AlertTriangle } from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import { translate } from '@/i18n/i18n'
import type { WorkspaceCleanupCandidate } from '../../../../shared/workspace-cleanup'
import type { WorkspaceCleanupReviewInfo } from './workspace-cleanup-presentation'
import {
  getWorkspaceCleanupUnfinishedWork,
  type WorkspaceCleanupUnfinishedWork
} from './workspace-cleanup-unfinished-work'

function workLabel(kind: WorkspaceCleanupUnfinishedWork, count: number): string {
  switch (kind) {
    case 'uncommitted-changes':
      return translate(
        'workspaceCleanup.unfinished.uncommitted',
        '{{count}} with uncommitted changes',
        {
          count
        }
      )
    case 'unpushed-commits':
      return translate('workspaceCleanup.unfinished.unpushed', '{{count}} with unpushed commits', {
        count
      })
    case 'unverified-push':
      return translate(
        'workspaceCleanup.unfinished.unverifiedPush',
        '{{count}} whose commits could not be checked as pushed',
        { count }
      )
    case 'open-review':
      return translate(
        'workspaceCleanup.unfinished.openOrUncheckedReview',
        '{{count}} with an open or unchecked review',
        {
          count
        }
      )
    case 'running':
      return translate(
        'workspaceCleanup.unfinished.running',
        '{{count}} with a running terminal or agent',
        {
          count
        }
      )
  }
}

/**
 * Names what the selected workspaces still hold and keeps them unless the person ticks the box.
 * The box starts unticked on every confirmation.
 */
export function WorkspaceCleanupUnfinishedWorkNotice({
  candidates,
  reviewFor,
  includeUnfinished,
  onIncludeUnfinishedChange
}: {
  candidates: readonly WorkspaceCleanupCandidate[]
  reviewFor: (candidate: WorkspaceCleanupCandidate) => WorkspaceCleanupReviewInfo
  includeUnfinished: boolean
  onIncludeUnfinishedChange: (include: boolean) => void
}): React.JSX.Element {
  const counts = new Map<WorkspaceCleanupUnfinishedWork, number>()
  for (const candidate of candidates) {
    for (const kind of getWorkspaceCleanupUnfinishedWork(candidate, reviewFor(candidate))) {
      counts.set(kind, (counts.get(kind) ?? 0) + 1)
    }
  }
  return (
    <div
      className="border-b border-border bg-destructive/5 px-5 py-3 text-xs leading-5"
      data-testid="workspace-cleanup-unfinished-work"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-destructive" />
        <div className="min-w-0">
          <div className="font-medium text-foreground">
            {translate(
              'workspaceCleanup.unfinished.title',
              '{{count}} of these still have work in them and will be kept',
              { count: candidates.length }
            )}
          </div>
          <div className="text-muted-foreground">
            {[...counts].map(([kind, count]) => workLabel(kind, count)).join(' · ')}
          </div>
        </div>
      </div>
      <label className="mt-2 flex cursor-pointer items-center gap-2 text-foreground">
        <Checkbox
          checked={includeUnfinished}
          onCheckedChange={(checked) => onIncludeUnfinishedChange(checked === true)}
          aria-label={translate(
            'workspaceCleanup.unfinished.includeAria',
            'Also delete the workspaces that still have work in them'
          )}
        />
        {translate(
          'workspaceCleanup.unfinished.include',
          'Also delete these {{count}} and the work in them',
          { count: candidates.length }
        )}
      </label>
    </div>
  )
}
