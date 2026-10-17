import { ExternalLink } from 'lucide-react'
import { useState } from 'react'
import type { ArtifactSessionRecord } from '../../../../../shared/artifact-session'
import { artifactLifecycleSnapshot } from '../../../../../shared/artifact-review'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { openArtifactInBrowser } from '@/components/artifacts/artifact-link-actions'
import { artifactReviewPill } from './artifact-review-pill'
import { pickSessionArtifact } from './session-artifact-mode'
import { SessionArtifactPreview } from './SessionArtifactPreview'
import { SessionSliteDoc, sliteDocTitle } from './SessionSliteDoc'
import type { SessionPanelItem } from './session-panel-items'
import { useArtifactReview } from './use-artifact-review'

type ArtifactItem = Extract<SessionPanelItem, { kind: 'artifact' }>
type SliteItem = Extract<SessionPanelItem, { kind: 'slite' }>

function sourceFileName(sourceKey: string): string {
  const parts = sourceKey.split(/[\\/]/).filter(Boolean)
  return parts.at(-1) ?? sourceKey
}

/** A name to read, not a URL slug: `side-panel-rollout` reads "Side panel rollout". */
function humanizedSlug(slug: string): string {
  const words = slug.replace(/[-_]+/g, ' ').trim()
  return words ? `${words[0]!.toUpperCase()}${words.slice(1)}` : slug
}

function artifactName(record: ArtifactSessionRecord): string {
  return sourceFileName(record.sourceKey) || humanizedSlug(record.slug)
}

function itemName(item: ArtifactItem | SliteItem): string {
  return item.kind === 'slite'
    ? (sliteDocTitle(item.id) ?? translate('auto.components.sessionArtifact.sliteDoc', 'Slite doc'))
    : artifactName(item.record)
}

function DocumentPicker({
  items,
  selectedKey,
  onSelect
}: {
  items: readonly (ArtifactItem | SliteItem)[]
  selectedKey: string
  onSelect: (key: string) => void
}): React.JSX.Element {
  return (
    <Select value={selectedKey} onValueChange={onSelect}>
      <SelectTrigger
        size="sm"
        className="h-7 w-full text-xs"
        aria-label={translate('sessionPanel.choose', 'Choose a plan, artifact or file')}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.key} value={item.key}>
            {itemName(item)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/**
 * The session's omnios pages (web view) or Slite plans: the picked one, else the newest, with a
 * picker only when there is more than one. Decisions happen in the browser, never here.
 */
export function SessionDocumentTab({
  items,
  visible,
  pickedKey,
  onPick
}: {
  items: readonly (ArtifactItem | SliteItem)[]
  visible: boolean
  pickedKey: string | null
  onPick: (key: string) => void
}): React.JSX.Element | null {
  const selected = pickSessionArtifact(items, pickedKey)
  if (!selected) {
    return null
  }
  const picker =
    items.length > 1 ? (
      <DocumentPicker items={items} selectedKey={selected.key} onSelect={onPick} />
    ) : null
  return selected.kind === 'slite' ? (
    <SessionSliteDoc
      key={selected.key}
      id={selected.id}
      url={selected.url}
      visible={visible}
      picker={picker}
    />
  ) : (
    <SessionArtifactView
      key={selected.key}
      record={selected.record}
      visible={visible}
      picker={picker}
    />
  )
}

function SessionArtifactView({
  record,
  visible,
  picker
}: {
  record: ArtifactSessionRecord
  visible: boolean
  picker: React.ReactNode
}): React.JSX.Element {
  const review = useArtifactReview(record.slug, visible)
  // Why the loaded page's own title next: it names the page even when the review read fails.
  const [pageTitle, setPageTitle] = useState<string | null>(null)
  const title =
    review?.artifact.title || pageTitle || review?.artifact.originalFileName || artifactName(record)
  const revision = typeof review?.artifact.revision === 'number' ? review.artifact.revision : null
  const pill = artifactReviewPill(
    review?.artifact.review?.status,
    review ? artifactLifecycleSnapshot(review) : null
  )
  const shareUrl = review?.shareUrl || record.shareUrl

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-1.5 border-b border-border px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <p className="min-w-0 flex-1 truncate text-xs font-medium" title={title}>
            {title}
          </p>
          {revision !== null ? (
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {translate('auto.components.sessionArtifact.revision', 'Rev {{value0}}', {
                value0: revision
              })}
            </span>
          ) : null}
          {pill ? (
            <span
              className={cn(
                'shrink-0 rounded-full border px-1.5 py-px text-[10px] font-medium',
                pill.className
              )}
            >
              {pill.label}
            </span>
          ) : null}
        </div>
        <div className="flex min-w-0 items-center gap-2">
          {picker ? <div className="min-w-0 flex-1">{picker}</div> : <div className="flex-1" />}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 shrink-0 gap-1.5 text-xs"
            onClick={() => openArtifactInBrowser(shareUrl)}
          >
            <ExternalLink className="size-3.5" />
            {translate('auto.components.sessionArtifact.openInBrowser', 'Open in browser')}
          </Button>
        </div>
      </div>
      <SessionArtifactPreview
        contentUrl={record.contentUrl}
        revision={revision}
        onTitle={setPageTitle}
      />
    </div>
  )
}
