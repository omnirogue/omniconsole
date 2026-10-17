import {
  CircleArrowRight,
  CircleCheck,
  CircleOff,
  Copy,
  ExternalLink,
  MessageSquare,
  RotateCcw,
  Trash2,
  Unlink
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { ArtifactListItem } from '../../../../shared/artifacts'
import { translate } from '@/i18n/i18n'
import {
  artifactLifecycleActionAvailability,
  type ArtifactLifecycleActionKey
} from './artifact-lifecycle-actions'
import { artifactItemHasLifecycle } from './artifact-lifecycle-model'
import { copyArtifactLink, openArtifactInBrowser } from './artifact-link-actions'

export type ArtifactRowAction = {
  key: string
  label: string
  icon: LucideIcon
  onSelect: () => void
  /** Rendered after a separator, styled as destructive. */
  destructive?: boolean
  separatorBefore?: boolean
  disabled?: boolean
}

export type ArtifactRowActionHandlers = {
  deleteArtifact: (item: ArtifactListItem) => void
  /** Absent on an older server: no lifecycle entries are offered. */
  lifecycle?: {
    run: (
      item: ArtifactListItem,
      key: 'markDone' | 'noAction' | 'reopen' | 'removeSuccessor'
    ) => void
    pickSuccessor: (item: ArtifactListItem) => void
    openSession: (item: ArtifactListItem) => void
    busy: (slug: string) => boolean
  }
}

function lifecycleLabel(key: ArtifactLifecycleActionKey): string {
  switch (key) {
    case 'markDone':
      return translate('auto.components.artifacts.rowActions.markDone', 'Mark done')
    case 'noAction':
      return translate('auto.components.artifacts.rowActions.noAction', 'No action')
    case 'supersede':
      return translate('auto.components.artifacts.rowActions.supersede', 'Superseded by…')
    case 'reopen':
      return translate('auto.components.artifacts.rowActions.reopen', 'Reopen')
    case 'removeSuccessor':
      return translate('auto.components.artifacts.rowActions.removeSuccessor', 'Remove successor')
    case 'openSession':
      return translate('auto.components.artifacts.rowActions.openSession', 'Open session')
  }
}

const LIFECYCLE_ICONS: Record<ArtifactLifecycleActionKey, LucideIcon> = {
  markDone: CircleCheck,
  noAction: CircleOff,
  supersede: CircleArrowRight,
  reopen: RotateCcw,
  removeSuccessor: Unlink,
  openSession: MessageSquare
}

const LIFECYCLE_ORDER: readonly ArtifactLifecycleActionKey[] = [
  'markDone',
  'noAction',
  'supersede',
  'reopen',
  'removeSuccessor',
  'openSession'
]

function lifecycleActions(
  item: ArtifactListItem,
  handlers: NonNullable<ArtifactRowActionHandlers['lifecycle']>
): ArtifactRowAction[] {
  const availability = artifactLifecycleActionAvailability(item)
  const busy = handlers.busy(item.artifact.slug)
  const onSelect = (key: ArtifactLifecycleActionKey) => (): void => {
    if (key === 'supersede') {
      handlers.pickSuccessor(item)
    } else if (key === 'openSession') {
      handlers.openSession(item)
    } else {
      handlers.run(item, key)
    }
  }
  return LIFECYCLE_ORDER.filter((key) => availability[key] !== 'hidden').map((key, index) => ({
    key,
    label: lifecycleLabel(key),
    icon: LIFECYCLE_ICONS[key],
    onSelect: onSelect(key),
    separatorBefore: index === 0,
    disabled: availability[key] === 'disabled' || (busy && key !== 'openSession')
  }))
}

// Why: the row dropdown, the row context menu and the drawer must offer the same actions.
export function artifactRowActions(
  item: ArtifactListItem,
  deleting: boolean,
  handlers: ArtifactRowActionHandlers,
  options: { includeLinkActions?: boolean } = {}
): readonly ArtifactRowAction[] {
  const lifecycle = handlers.lifecycle && artifactItemHasLifecycle(item) ? handlers.lifecycle : null
  const copy: ArtifactRowAction = {
    key: 'copy',
    label: translate('auto.components.artifacts.copyLink', 'Copy link'),
    icon: Copy,
    onSelect: () => void copyArtifactLink(item.shareUrl)
  }
  const open: ArtifactRowAction = {
    key: 'open',
    label: translate('auto.components.artifacts.openInBrowser', 'Open in browser'),
    icon: ExternalLink,
    onSelect: () => openArtifactInBrowser(item.shareUrl)
  }
  const links = options.includeLinkActions === false ? [] : lifecycle ? [open, copy] : [copy, open]
  return [
    ...links,
    ...(lifecycle ? lifecycleActions(item, lifecycle) : []),
    {
      key: 'delete',
      label: translate('auto.components.artifacts.ArtifactsPage.deleteArtifact', 'Delete artifact'),
      icon: Trash2,
      onSelect: () => handlers.deleteArtifact(item),
      destructive: true,
      disabled: deleting
    }
  ]
}
