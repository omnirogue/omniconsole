import { useEffect, useState } from 'react'
import { ExternalLink, MessageSquare } from 'lucide-react'
import type { ArtifactListItem } from '../../../../shared/artifacts'
import type { ArtifactReviewStatus } from '../../../../shared/artifact-review'
import { translate } from '@/i18n/i18n'
import { fetchSessionArtifactReview } from '../right-sidebar/session-artifact/session-artifact-client'
import {
  artifactAudienceLabel,
  artifactDecisionsSummary,
  artifactReviewersLabel,
  artifactWhoLabel
} from './artifact-lifecycle-labels'
import { deriveArtifactRowStatus } from './artifact-lifecycle-model'
import { openArtifactInBrowser } from './artifact-link-actions'
import { ArtifactStatusChip, ArtifactStatusGlyph } from './ArtifactStatusCells'

type StatusRead =
  | { state: 'loading' }
  | { state: 'failed' }
  | { state: 'ok'; value: ArtifactReviewStatus }

/**
 * The status document for the open drawer, re-read whenever the row's lifecycle or revision
 * changes, or on `retry`. A failed read stays distinct from an empty decision history.
 */
function useArtifactStatusDocument(item: ArtifactListItem): StatusRead & { retry: () => void } {
  const { slug, updatedAt, closedAt, supersededAt, revision } = item.artifact
  const [attempt, setAttempt] = useState(0)
  const [read, setRead] = useState<{ key: string; read: StatusRead } | null>(null)
  const key = [slug, updatedAt, closedAt, supersededAt, revision, attempt].join('|')
  useEffect(() => {
    let cancelled = false
    const settle = (next: StatusRead): void => {
      if (!cancelled) {
        setRead({ key, read: next })
      }
    }
    fetchSessionArtifactReview(slug).then(
      (value) => settle(value ? { state: 'ok', value } : { state: 'failed' }),
      () => settle({ state: 'failed' })
    )
    return () => {
      cancelled = true
    }
  }, [slug, key])
  const current = read?.key === key ? read.read : { state: 'loading' as const }
  return { ...current, retry: () => setAttempt((value) => value + 1) }
}

/** Compact line under the drawer header: status · audience · reviewers · decisions · links. */
export function ArtifactDetailMeta({
  item,
  sessionTitle,
  successorTitle,
  onOpenSuccessor,
  onOpenSession
}: {
  item: ArtifactListItem
  sessionTitle: string | null
  successorTitle: string | null
  onOpenSuccessor: (slug: string) => void
  onOpenSession: (item: ArtifactListItem) => void
}): React.JSX.Element {
  const statusRead = useArtifactStatusDocument(item)
  const status = deriveArtifactRowStatus(item)
  const audience = artifactAudienceLabel(item.artifact.audience)
  const reviewers = artifactReviewersLabel(item)
  const decisions =
    statusRead.state === 'ok' ? artifactDecisionsSummary(statusRead.value.decisions) : null
  const who = artifactWhoLabel(item, sessionTitle)
  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/50 px-4 py-2 text-xs text-muted-foreground"
      aria-label={translate('auto.components.artifacts.lifecycle.details', 'Page details')}
    >
      {status.kind !== 'none' ? (
        <span className="flex min-w-0 items-center gap-1.5">
          <ArtifactStatusGlyph status={status} />
          <ArtifactStatusChip
            status={status}
            successorTitle={successorTitle}
            onOpenSuccessor={onOpenSuccessor}
          />
        </span>
      ) : null}
      {audience ? <span>{audience}</span> : null}
      {reviewers ? <span className="min-w-0 truncate">{reviewers}</span> : null}
      {decisions ? <span className="min-w-0 truncate">{decisions}</span> : null}
      {statusRead.state === 'failed' ? (
        <span className="inline-flex items-center gap-1" role="status">
          {translate(
            'auto.components.artifacts.lifecycle.decisionsUnavailable',
            'Decision history unavailable'
          )}
          {' · '}
          <button
            type="button"
            className="text-foreground hover:underline"
            onClick={statusRead.retry}
          >
            {translate('auto.components.artifacts.lifecycle.retry', 'Retry')}
          </button>
        </span>
      ) : null}
      {item.artifact.closedRef && status.kind !== 'done' ? (
        <button
          type="button"
          className="inline-flex items-center gap-1 hover:text-foreground hover:underline"
          onClick={() => openArtifactInBrowser(item.artifact.closedRef ?? '')}
        >
          <ExternalLink className="size-3" />
          {translate('auto.components.artifacts.lifecycle.result', 'Result')}
        </button>
      ) : null}
      {item.sessionRef ? (
        <button
          type="button"
          className="inline-flex min-w-0 items-center gap-1 hover:text-foreground hover:underline"
          onClick={() => onOpenSession(item)}
        >
          <MessageSquare className="size-3 shrink-0" />
          <span className="truncate">{who}</span>
        </button>
      ) : null}
    </div>
  )
}
