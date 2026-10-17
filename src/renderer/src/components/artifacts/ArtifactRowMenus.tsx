import { Fragment } from 'react'
import { MoreHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator
} from '@/components/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import type { ArtifactRowAction } from './artifact-row-actions'

export function ArtifactRowDropdownItems({
  actions
}: {
  actions: readonly ArtifactRowAction[]
}): React.JSX.Element {
  return (
    <>
      {actions.map(
        ({ key, label, icon: Icon, onSelect, destructive, separatorBefore, disabled }, index) => (
          <Fragment key={key}>
            {(destructive || separatorBefore) && index > 0 ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem
              variant={destructive ? 'destructive' : 'default'}
              disabled={disabled}
              onSelect={onSelect}
            >
              <Icon className="size-3.5" />
              {label}
            </DropdownMenuItem>
          </Fragment>
        )
      )}
    </>
  )
}

export function ArtifactRowDropdown({
  actions
}: {
  actions: readonly ArtifactRowAction[]
}): React.JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="size-7 text-muted-foreground"
          aria-label={translate('auto.components.artifacts.actions', 'Artifact actions')}
          onClick={(event) => event.stopPropagation()}
        >
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <ArtifactRowDropdownItems actions={actions} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function ArtifactRowContextMenu({
  actions
}: {
  actions: readonly ArtifactRowAction[]
}): React.JSX.Element {
  return (
    <ContextMenuContent className="w-48">
      {actions.map(
        ({ key, label, icon: Icon, onSelect, destructive, separatorBefore, disabled }, index) => (
          <Fragment key={key}>
            {(destructive || separatorBefore) && index > 0 ? <ContextMenuSeparator /> : null}
            <ContextMenuItem
              variant={destructive ? 'destructive' : 'default'}
              disabled={disabled}
              onSelect={onSelect}
            >
              <Icon className="size-3.5" />
              {label}
            </ContextMenuItem>
          </Fragment>
        )
      )}
    </ContextMenuContent>
  )
}
