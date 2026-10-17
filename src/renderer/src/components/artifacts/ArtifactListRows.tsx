import type { ArtifactListItem } from '../../../../shared/artifacts'
import { Checkbox } from '@/components/ui/checkbox'
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { isPortaledRowMenuClick, isRowActivationKey } from '@/lib/list-row-interaction'
import {
  artifactName,
  artifactTypeLabel,
  formatArtifactExpiryCompact,
  formatArtifactUpdatedCompact,
  formatByteSize
} from './artifact-display-labels'
import { artifactHoverDetails, artifactWhoLabel } from './artifact-lifecycle-labels'
import { deriveArtifactRowStatus } from './artifact-lifecycle-model'
import { artifactRowActions, type ArtifactRowActionHandlers } from './artifact-row-actions'
import {
  ARTIFACTS_LIFECYCLE_TABLE_GRID_CLASS,
  ARTIFACTS_TABLE_GRID_CLASS
} from './artifacts-table-layout'
import { ArtifactRowContextMenu, ArtifactRowDropdown } from './ArtifactRowMenus'
import { ArtifactNameCell, ArtifactStatusChip, ArtifactStatusGlyph } from './ArtifactStatusCells'
import type { ArtifactSessionLink } from './use-artifact-session-links'
import { LIST_TABLE_ROW_CLASS, LIST_TABLE_ROW_SELECTED_CLASS } from '@/lib/list-table-layout'

/** Present only when the server reported lifecycle fields; absent renders the older table. */
export type ArtifactRowsLifecycle = {
  handlers: NonNullable<ArtifactRowActionHandlers['lifecycle']>
  checkedSlugs: ReadonlySet<string>
  toggleChecked: (slug: string, shiftKey: boolean) => void
  sessionLinks: ReadonlyMap<string, ArtifactSessionLink>
  titleForSlug: (slug: string) => string | null
  openSuccessor: (slug: string) => void
}

function LegacyCells({ item }: { item: ArtifactListItem }): React.JSX.Element {
  const name = artifactName(item)
  const typeLabel = artifactTypeLabel(item)
  const updatedLabel = formatArtifactUpdatedCompact(item.artifact.updatedAt)
  const expiryLabel = formatArtifactExpiryCompact(item.artifact.expiresAt)
  const sizeLabel = formatByteSize(item.artifact.byteSize)
  return (
    <>
      <span className="min-w-0 truncate font-medium" title={name}>
        {name}
      </span>
      <span className="min-w-0 truncate text-muted-foreground" title={typeLabel}>
        {typeLabel}
      </span>
      <span className="min-w-0 truncate text-muted-foreground" title={sizeLabel}>
        {sizeLabel}
      </span>
      <span className="min-w-0 truncate text-muted-foreground" title={updatedLabel}>
        {updatedLabel}
      </span>
      <span className="min-w-0 truncate text-muted-foreground" title={expiryLabel}>
        {expiryLabel}
      </span>
    </>
  )
}

function LifecycleCells({
  item,
  lifecycle
}: {
  item: ArtifactListItem
  lifecycle: ArtifactRowsLifecycle
}): React.JSX.Element {
  const slug = item.artifact.slug
  const name = artifactName(item)
  const status = deriveArtifactRowStatus(item)
  const link = lifecycle.sessionLinks.get(slug) ?? null
  const who = artifactWhoLabel(item, link?.title ?? null)
  const updatedLabel = formatArtifactUpdatedCompact(item.artifact.updatedAt)
  const successorTitle =
    status.kind === 'superseded' ? lifecycle.titleForSlug(status.successorSlug) : null
  return (
    <>
      <span className="flex items-center" onClick={(event) => event.stopPropagation()}>
        <Checkbox
          checked={lifecycle.checkedSlugs.has(slug)}
          aria-label={translate('auto.components.artifacts.lifecycle.select', 'Select {{name}}', {
            name
          })}
          onClick={(event) => {
            event.preventDefault()
            lifecycle.toggleChecked(slug, event.shiftKey)
          }}
        />
      </span>
      <ArtifactStatusGlyph status={status} />
      <ArtifactNameCell item={item} hover={artifactHoverDetails(item)} />
      {item.sessionRef ? (
        <button
          type="button"
          className="min-w-0 truncate text-left text-muted-foreground hover:text-foreground hover:underline"
          title={who}
          onClick={(event) => {
            event.stopPropagation()
            lifecycle.handlers.openSession(item)
          }}
        >
          {who}
        </button>
      ) : (
        <span className="min-w-0 truncate text-muted-foreground" title={who}>
          {who}
        </span>
      )}
      <ArtifactStatusChip
        status={status}
        successorTitle={successorTitle}
        onOpenSuccessor={lifecycle.openSuccessor}
      />
      <span className="min-w-0 truncate text-muted-foreground" title={updatedLabel}>
        {updatedLabel}
      </span>
    </>
  )
}

export function ArtifactListRows({
  artifacts,
  deletingId,
  selectedSlug,
  selectArtifact,
  deleteArtifact,
  lifecycle
}: {
  artifacts: readonly ArtifactListItem[]
  deletingId: string | null
  selectedSlug: string | null
  selectArtifact: (slug: string) => void
  deleteArtifact: (item: ArtifactListItem) => void
  lifecycle?: ArtifactRowsLifecycle
}): React.JSX.Element {
  return (
    <>
      {artifacts.map((item) => {
        const isSelected = selectedSlug === item.artifact.slug
        const deleting = deletingId === item.artifact.slug
        const rowActions = artifactRowActions(item, deleting, {
          deleteArtifact,
          lifecycle: lifecycle?.handlers
        })

        return (
          <ContextMenu key={item.artifact.slug}>
            <ContextMenuTrigger asChild>
              <div
                role="button"
                tabIndex={0}
                data-current={isSelected ? 'true' : undefined}
                data-checked={lifecycle?.checkedSlugs.has(item.artifact.slug) ? 'true' : undefined}
                onClick={(event) => {
                  if (isPortaledRowMenuClick(event)) {
                    return
                  }
                  selectArtifact(item.artifact.slug)
                }}
                onKeyDown={(event) => {
                  if (!isRowActivationKey(event)) {
                    return
                  }
                  event.preventDefault()
                  selectArtifact(item.artifact.slug)
                }}
                className={cn(
                  lifecycle ? ARTIFACTS_LIFECYCLE_TABLE_GRID_CLASS : ARTIFACTS_TABLE_GRID_CLASS,
                  LIST_TABLE_ROW_CLASS,
                  isSelected && LIST_TABLE_ROW_SELECTED_CLASS
                )}
              >
                {lifecycle ? (
                  <LifecycleCells item={item} lifecycle={lifecycle} />
                ) : (
                  <LegacyCells item={item} />
                )}
                <ArtifactRowDropdown actions={rowActions} />
              </div>
            </ContextMenuTrigger>
            <ArtifactRowContextMenu actions={rowActions} />
          </ContextMenu>
        )
      })}
    </>
  )
}
