import {
  Circle,
  CircleArrowRight,
  CircleCheck,
  CircleDashed,
  CircleDot,
  Contrast,
  ExternalLink,
  type LucideIcon
} from 'lucide-react'
import type { ArtifactListItem } from '../../../../shared/artifacts'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { ArtifactRowStatus } from './artifact-lifecycle-model'
import {
  artifactKindLabel,
  artifactStatusText,
  artifactSuccessorFallbackTitle
} from './artifact-lifecycle-labels'
import { artifactName } from './artifact-display-labels'
import { openArtifactInBrowser } from './artifact-link-actions'

const STATUS_GLYPH: Record<ArtifactRowStatus['kind'], { icon: LucideIcon; tone: string } | null> = {
  superseded: { icon: CircleArrowRight, tone: 'text-muted-foreground' },
  done: { icon: CircleCheck, tone: 'text-status-success' },
  no_action: { icon: Circle, tone: 'text-muted-foreground' },
  decided: { icon: Contrast, tone: 'text-status-info' },
  needs_you: { icon: CircleDot, tone: 'text-status-warning' },
  pending: { icon: CircleDashed, tone: 'text-muted-foreground' },
  none: null
}

export function ArtifactStatusGlyph({ status }: { status: ArtifactRowStatus }): React.JSX.Element {
  const glyph = STATUS_GLYPH[status.kind]
  if (!glyph) {
    return <span aria-hidden />
  }
  const Icon = glyph.icon
  return <Icon aria-hidden className={cn('size-3.5 shrink-0', glyph.tone)} />
}

/** The Status column: chip words, with the successor or result as a click target. */
export function ArtifactStatusChip({
  status,
  successorTitle,
  onOpenSuccessor
}: {
  status: ArtifactRowStatus
  successorTitle: string | null
  onOpenSuccessor: (slug: string) => void
}): React.JSX.Element {
  const text = artifactStatusText(status, successorTitle ?? artifactSuccessorFallbackTitle())
  const tone = STATUS_GLYPH[status.kind]?.tone ?? 'text-muted-foreground'
  if (status.kind === 'superseded') {
    return (
      <button
        type="button"
        className={cn('min-w-0 truncate text-left hover:underline', tone)}
        title={text}
        onClick={(event) => {
          event.stopPropagation()
          onOpenSuccessor(status.successorSlug)
        }}
      >
        {text}
      </button>
    )
  }
  return (
    <span className={cn('flex min-w-0 items-center gap-1', tone)} title={text}>
      <span className="truncate">{text}</span>
      {status.kind === 'done' && status.closedRef ? (
        <button
          type="button"
          className="inline-flex shrink-0 items-center gap-0.5 text-muted-foreground hover:text-foreground"
          aria-label={translate('auto.components.artifacts.lifecycle.openResult', 'Open result')}
          onClick={(event) => {
            event.stopPropagation()
            openArtifactInBrowser(status.closedRef ?? '')
          }}
        >
          · <ExternalLink className="size-3" />
        </button>
      ) : null}
    </span>
  )
}

/** Name + optional kind chip + "rev N" when the page has been revised. */
export function ArtifactNameCell({
  item,
  hover
}: {
  item: ArtifactListItem
  hover: string
}): React.JSX.Element {
  const name = artifactName(item)
  const kind = artifactKindLabel(item.artifact.review?.context?.kind)
  const revision = item.artifact.revision
  return (
    <span className="flex min-w-0 items-center gap-1.5" title={hover}>
      <span className="min-w-0 truncate font-medium">{name}</span>
      {kind ? (
        <span className="shrink-0 rounded-full border border-border px-1.5 py-px text-[10px] text-muted-foreground">
          {kind}
        </span>
      ) : null}
      {typeof revision === 'number' && revision > 1 ? (
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {translate('auto.components.artifacts.lifecycle.revision', 'rev {{revision}}', {
            revision
          })}
        </span>
      ) : null}
    </span>
  )
}
