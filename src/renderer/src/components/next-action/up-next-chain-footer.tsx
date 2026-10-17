import { translate as t } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import type { UpNextView } from '../../../../shared/up-next-types'
import type { UpNextController } from './use-up-next'
import { primaryLabel, queueableDrafts } from './up-next-labels'
import { UpNextSummaryLine } from './up-next-summary-line'
import { idleEmpty } from './up-next-chain-rules'

/**
 * The composer's foot (amendments 3 and 14): the computed summary on the left, "discard drafts"
 * and the one primary button on the right. It never restates the track's state — the header
 * line under UP NEXT does that once. Idle with nothing composed it is not there at all: the
 * summary would read "Nothing queued." under a slot that already says so (`idleEmpty`).
 */
export function UpNextChainFooter({
  view,
  controller,
  closed
}: {
  view: UpNextView
  controller: UpNextController
  closed: boolean
}): React.JSX.Element | null {
  if (idleEmpty(view)) {
    return null
  }
  return (
    <footer className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-border pt-3">
      <UpNextSummaryLine view={view} />
      {(!closed || view.draftCount > 0) && (
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {/* Why also when closed: drafts a finished run never ran are still the person's to drop. */}
          {view.draftCount > 0 && (
            <Button
              size="xs"
              variant="link"
              className="text-muted-foreground"
              disabled={controller.disabled}
              onClick={() => void controller.discardDrafts()}
            >
              {t('upNext.discard', 'discard drafts')}
            </Button>
          )}
          {!closed && (
            <Button
              size="sm"
              // Why not draftCount: a draft behind a send that does not wait is never queued.
              disabled={controller.disabled || !queueableDrafts(view).length}
              onClick={() => void controller.commit()}
            >
              {primaryLabel(view)}
            </Button>
          )}
        </div>
      )}
    </footer>
  )
}
