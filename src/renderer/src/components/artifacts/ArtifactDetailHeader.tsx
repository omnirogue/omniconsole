import type { ReactNode } from 'react'
import { Globe, Users, X } from 'lucide-react'
import type { ArtifactListItem } from '../../../../shared/artifacts'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { ArtifactActions } from './ArtifactActions'
import { artifactAudienceLabel } from './artifact-lifecycle-labels'
import type { ArtifactRowActionHandlers } from './artifact-row-actions'
import {
  formatArtifactExpiry,
  formatArtifactUpdatedAt,
  formatByteSize
} from './artifact-display-labels'

export function ArtifactDetailHeader({
  deleting,
  item,
  title,
  onClose,
  onDelete,
  lifecycle
}: {
  deleting: boolean
  item: ArtifactListItem
  title: ReactNode
  onClose: () => void
  onDelete: (target: ArtifactListItem) => void
  lifecycle?: ArtifactRowActionHandlers['lifecycle']
}): React.JSX.Element {
  // Why: an older server reports no audience; its pages are public, as the line always said.
  const audience =
    artifactAudienceLabel(item.artifact.audience) ??
    translate(
      'auto.components.artifacts.ArtifactDetailHeader.publicLink',
      'Anyone with this link can view it'
    )
  const AudienceIcon =
    item.artifact.audience === 'team' || item.artifact.audience === 'reviewers' ? Users : Globe
  return (
    // Why: the drawer is right-anchored under the fixed Windows/Linux window-controls
    // overlay, which paints above it — inset the actions so they stay clickable.
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border/50 px-4 py-3 pr-[max(1rem,var(--window-controls-width,0px))]">
      {/* Why: a floor rather than min-w-0 — otherwise the title truncates to nothing before the actions wrap. */}
      <div className="min-w-40 flex-1 space-y-0.5">
        {title}
        <div className="flex min-w-0 items-center gap-1.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <AudienceIcon className="size-3 shrink-0 text-muted-foreground" />
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {audience}
            </TooltipContent>
          </Tooltip>
          <span className="sr-only">{audience}</span>
          <p className="truncate font-mono text-xs text-muted-foreground">{item.shareUrl}</p>
        </div>
        <p className="truncate text-[11px] text-muted-foreground">
          {formatArtifactUpdatedAt(item.artifact.updatedAt)} ·{' '}
          {formatByteSize(item.artifact.byteSize)} · {formatArtifactExpiry(item.artifact.expiresAt)}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <ArtifactActions
          deleting={deleting}
          item={item}
          onDelete={onDelete}
          lifecycle={lifecycle}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          aria-label={translate('auto.components.artifacts.ArtifactDetailHeader.close', 'Close')}
        >
          <X />
        </Button>
      </div>
    </div>
  )
}
