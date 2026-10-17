import { cn } from '@/lib/utils'
import { Checkbox } from '@/components/ui/checkbox'
import { translate } from '@/i18n/i18n'
import {
  ARTIFACTS_LIFECYCLE_TABLE_GRID_CLASS,
  ARTIFACTS_TABLE_GRID_CLASS
} from './artifacts-table-layout'
import { LIST_TABLE_HEADER_CLASS } from '@/lib/list-table-layout'

export type ArtifactHeaderSelection = {
  state: boolean | 'indeterminate'
  onToggleAll: () => void
}

export function ArtifactListTableHeader({
  selection
}: {
  /** Present with lifecycle fields: the lifecycle columns and a select-all box. */
  selection?: ArtifactHeaderSelection
}): React.JSX.Element {
  if (selection) {
    return (
      <div className={cn(ARTIFACTS_LIFECYCLE_TABLE_GRID_CLASS, LIST_TABLE_HEADER_CLASS)}>
        <span className="flex items-center">
          <Checkbox
            checked={selection.state}
            aria-label={translate(
              'auto.components.artifacts.ArtifactListTableHeader.selectAll',
              'Select all loaded pages'
            )}
            onCheckedChange={selection.onToggleAll}
          />
        </span>
        <span aria-hidden />
        <span>{translate('auto.components.artifacts.ArtifactListTableHeader.name', 'Name')}</span>
        <span>{translate('auto.components.artifacts.ArtifactListTableHeader.who', 'Who')}</span>
        <span>
          {translate('auto.components.artifacts.ArtifactListTableHeader.status', 'Status')}
        </span>
        <span>
          {translate('auto.components.artifacts.ArtifactListTableHeader.updated', 'Updated')}
        </span>
        <span className="sr-only">
          {translate('auto.components.artifacts.ArtifactListTableHeader.actions', 'Actions')}
        </span>
      </div>
    )
  }
  return (
    <div className={cn(ARTIFACTS_TABLE_GRID_CLASS, LIST_TABLE_HEADER_CLASS)}>
      <span>{translate('auto.components.artifacts.ArtifactListTableHeader.name', 'Name')}</span>
      <span>{translate('auto.components.artifacts.ArtifactListTableHeader.type', 'Type')}</span>
      <span>{translate('auto.components.artifacts.ArtifactListTableHeader.size', 'Size')}</span>
      <span>
        {translate('auto.components.artifacts.ArtifactListTableHeader.updated', 'Updated')}
      </span>
      <span>
        {translate('auto.components.artifacts.ArtifactListTableHeader.expires', 'Expires')}
      </span>
      <span className="sr-only">
        {translate('auto.components.artifacts.ArtifactListTableHeader.actions', 'Actions')}
      </span>
    </div>
  )
}
