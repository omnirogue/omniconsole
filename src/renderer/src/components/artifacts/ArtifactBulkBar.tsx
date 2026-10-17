import { CircleArrowRight, CircleCheck, CircleOff, Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { ArtifactBulkAction } from './artifact-bulk-lifecycle'

/** Shown with one or more rows checked. No bulk delete, share or approve by design. */
export function ArtifactBulkBar({
  count,
  running,
  onAction,
  onClear
}: {
  count: number
  running: boolean
  onAction: (action: ArtifactBulkAction) => void
  onClear: () => void
}): React.JSX.Element | null {
  if (count === 0) {
    return null
  }
  return (
    <div
      role="toolbar"
      aria-label={translate('auto.components.artifacts.bulk.label', 'Selected pages')}
      className="mx-3 mb-2 flex shrink-0 flex-wrap items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5 text-sm md:mx-5"
    >
      <span className="mr-1 text-xs font-medium text-muted-foreground">
        {translate('auto.components.artifacts.bulk.count', '{{total}} selected', { total: count })}
      </span>
      {running ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" /> : null}
      <Button size="xs" variant="outline" disabled={running} onClick={() => onAction('done')}>
        <CircleCheck className="size-3.5" />
        {translate('auto.components.artifacts.bulk.markDone', 'Mark done')}
      </Button>
      <Button size="xs" variant="outline" disabled={running} onClick={() => onAction('no_action')}>
        <CircleOff className="size-3.5" />
        {translate('auto.components.artifacts.bulk.noAction', 'No action')}
      </Button>
      <Button size="xs" variant="outline" disabled={running} onClick={() => onAction('supersede')}>
        <CircleArrowRight className="size-3.5" />
        {translate('auto.components.artifacts.bulk.supersede', 'Superseded by…')}
      </Button>
      <Button size="xs" variant="ghost" disabled={running} onClick={onClear} className="ml-auto">
        <X className="size-3.5" />
        {translate('auto.components.artifacts.bulk.clear', 'Clear')}
      </Button>
    </div>
  )
}
