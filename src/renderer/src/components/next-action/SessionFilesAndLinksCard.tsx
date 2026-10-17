import {
  Copy,
  ExternalLink,
  File,
  FileCode2,
  FileSpreadsheet,
  FileText,
  Film,
  FolderOpen,
  GitPullRequest,
  Globe,
  Image as ImageIcon,
  Music,
  Rocket,
  Server,
  Sparkles,
  type LucideIcon
} from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import type { FilesAndLinksCard, SessionFileCard } from '@/lib/session-files-and-links'
import {
  canOpenSessionFileLocally,
  canOpenSessionUrlExternally,
  sessionFilesAndLinksActions as actions,
  type SessionFileTarget
} from '@/lib/session-files-and-links-actions'
import { cn } from '@/lib/utils'
import type { SessionFileKind } from '../../../../shared/session-file-kind'
import { useSessionFileThumbnail, type LoopbackLiveness } from './use-session-files-and-links'

type CardAction = { label: string; run: () => void }
type SecondaryAction = CardAction & { icon: LucideIcon }

const FILE_ICONS: Record<SessionFileKind, LucideIcon> = {
  image: ImageIcon,
  video: Film,
  audio: Music,
  document: FileText,
  html: FileCode2,
  pdf: FileText,
  markdown: FileText,
  csv: FileSpreadsheet,
  other: File
}
const LINK_ICONS = {
  artifact: Sparkles,
  localhost: Server,
  preview: Rocket,
  service: Globe
} as const
const CARD_TYPE_ICONS = { 'pull-request': GitPullRequest, folder: FolderOpen } as const

function openInApp(): string {
  return translate('filesAndLinks.openInApp', 'Open')
}
function systemBrowser(run: () => void): SecondaryAction {
  return {
    label: translate('filesAndLinks.openInSystemBrowser', 'Open in system browser'),
    icon: ExternalLink,
    run
  }
}
function reveal(path: string, target: SessionFileTarget): SecondaryAction {
  return {
    label: translate('filesAndLinks.reveal', 'Reveal in file manager'),
    icon: FolderOpen,
    run: () => actions.reveal(path, target)
  }
}

function fileActions(
  card: SessionFileCard,
  target: SessionFileTarget
): [CardAction, SecondaryAction] {
  switch (card.kind) {
    case 'image':
      return [
        {
          label: translate('filesAndLinks.view', 'View'),
          run: () => actions.openFile(card.path, target)
        },
        reveal(card.path, target)
      ]
    case 'video':
      return [
        {
          label: translate('filesAndLinks.play', 'Play'),
          run: () => actions.playVideo(card.path, target)
        },
        reveal(card.path, target)
      ]
    case 'html':
      return [
        { label: openInApp(), run: () => actions.openFile(card.path, target) },
        systemBrowser(() => actions.openFileInSystemApp(card.path, target))
      ]
    case 'other':
      return [
        {
          label: translate('filesAndLinks.edit', 'Edit'),
          run: () => actions.openFile(card.path, target)
        },
        reveal(card.path, target)
      ]
    case 'audio':
    case 'document':
      // Why the OS app: the person's own player or office app opens these best.
      return [
        { label: openInApp(), run: () => actions.openFileInSystemApp(card.path, target) },
        reveal(card.path, target)
      ]
    case 'pdf':
    case 'markdown':
    case 'csv':
      return [
        { label: openInApp(), run: () => actions.openFile(card.path, target) },
        reveal(card.path, target)
      ]
  }
}

function cardActions(
  card: FilesAndLinksCard,
  worktreeId: string,
  hostId: string | null | undefined,
  target: SessionFileTarget | null
): [CardAction, SecondaryAction | null] | null {
  if (card.type === 'folder') {
    return target && canOpenSessionFileLocally(target, card.revealPath)
      ? [
          {
            label: translate('filesAndLinks.showFolder', 'Show folder'),
            run: () => actions.reveal(card.revealPath, target)
          },
          null
        ]
      : null
  }
  if (card.type === 'file') {
    if (!target) {
      return null
    }
    const [primary, secondary] = fileActions(card, target)
    return [primary, canOpenSessionFileLocally(target, card.path) ? secondary : null]
  }
  if (card.type === 'link' && (card.kind === 'artifact' || card.kind === 'service')) {
    // Why: artifacts and Drive/Notion/Meta pages need the person's own browser sign-in.
    return [
      {
        label: translate('filesAndLinks.openInBrowser', 'Open in browser'),
        run: () => actions.openUrlInSystemBrowser(card.url, hostId)
      },
      {
        label: translate('filesAndLinks.copyLink', 'Copy link'),
        icon: Copy,
        run: () => void actions.copyLink(card.url)
      }
    ]
  }
  return [
    { label: openInApp(), run: () => actions.openUrlInApp(card.url, worktreeId, hostId) },
    canOpenSessionUrlExternally(card.url, hostId)
      ? systemBrowser(() => actions.openUrlInSystemBrowser(card.url, hostId))
      : null
  ]
}

function pullRequestSummary(card: Extract<FilesAndLinksCard, { type: 'pull-request' }>): string {
  const parts = [translate('filesAndLinks.pullRequest', 'PR #{{number}}', { number: card.number })]
  if (card.state) {
    parts.push(
      {
        open: translate('filesAndLinks.prOpen', 'open'),
        draft: translate('filesAndLinks.prDraft', 'draft'),
        merged: translate('filesAndLinks.prMerged', 'merged'),
        closed: translate('filesAndLinks.prClosed', 'closed')
      }[card.state]
    )
  }
  if (card.checks) {
    parts.push(
      {
        pending: translate('filesAndLinks.checksPending', 'checks running'),
        success: translate('filesAndLinks.checksPassing', 'checks passing'),
        failure: translate('filesAndLinks.checksFailing', 'checks failing'),
        neutral: translate('filesAndLinks.checksNeutral', 'checks neutral')
      }[card.checks]
    )
  }
  return parts.join(' · ')
}

function Thumbnail({
  card,
  target
}: {
  card: FilesAndLinksCard
  target: SessionFileTarget | null
}): React.JSX.Element {
  const file = card.type === 'file' ? card : null
  const src = useSessionFileThumbnail(file?.path ?? '', file?.kind ?? 'other', target)
  if (src) {
    return (
      <img
        src={src}
        alt=""
        className="size-9 shrink-0 rounded border object-cover"
        data-files-links-thumbnail=""
      />
    )
  }
  // Why a lookup, not a helper call: the React compiler rejects components returned by a call.
  const Icon =
    card.type === 'file'
      ? FILE_ICONS[card.kind]
      : card.type === 'link'
        ? LINK_ICONS[card.kind]
        : CARD_TYPE_ICONS[card.type]
  return (
    <span className="flex size-9 shrink-0 items-center justify-center rounded border bg-muted/40">
      <Icon className="size-4 text-muted-foreground" aria-hidden />
    </span>
  )
}

function LivenessDot({ liveness }: { liveness: LoopbackLiveness | undefined }): ReactNode {
  if (!liveness) {
    return null
  }
  const label =
    liveness === 'live'
      ? translate('filesAndLinks.serverLive', 'Running')
      : liveness === 'stopped'
        ? translate('filesAndLinks.serverStopped', 'Stopped')
        : translate('filesAndLinks.serverUnknown', 'Status unavailable')
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-files-links-liveness={liveness}
      className={cn(
        'inline-block size-1.5 shrink-0 rounded-full',
        liveness === 'live' ? 'bg-status-success' : 'bg-muted-foreground/50'
      )}
    />
  )
}

function cardName(card: FilesAndLinksCard): string {
  switch (card.type) {
    case 'pull-request':
      return pullRequestSummary(card)
    case 'folder':
    case 'file':
      return card.name
    case 'link':
      if (card.kind === 'artifact') {
        return translate('filesAndLinks.artifact', 'Claude artifact')
      }
      return card.pullRequestNumber === undefined
        ? card.name
        : translate('filesAndLinks.previewOfPullRequest', 'PR #{{number}} preview', {
            number: card.pullRequestNumber
          })
  }
}

/** The second line: where it lives, plus how many pages or files it stands for. */
function cardLocation(card: FilesAndLinksCard): string {
  if (card.type === 'folder') {
    const files = translate('filesAndLinks.folderFiles', '{{count}} files', { count: card.count })
    return card.location ? `${files} · ${card.location}` : files
  }
  if (card.type === 'link' && card.pages) {
    const pages = translate('filesAndLinks.previewPages', '{{count}} pages', { count: card.pages })
    return card.location ? `${card.location} · ${pages}` : pages
  }
  return card.location
}

function cardKindAttribute(card: FilesAndLinksCard): string {
  return card.type === 'pull-request' || card.type === 'folder' ? card.type : card.kind
}

export function SessionFilesAndLinksCard({
  card,
  worktreeId,
  hostId,
  target,
  liveness,
  prominent = false
}: {
  card: FilesAndLinksCard
  worktreeId: string
  hostId?: string | null
  target: SessionFileTarget | null
  liveness?: LoopbackLiveness
  /** The session's Result: set apart from the folded list below it. */
  prominent?: boolean
}): React.JSX.Element {
  const found = cardActions(card, worktreeId, hostId, target)
  const name = cardName(card)
  const location = cardLocation(card)
  const detail = card.type === 'file' || card.type === 'folder' ? card.path : card.url
  const [primary, secondary] = found ?? [null, null]
  return (
    <li
      className={cn(
        'flex min-w-0 items-center gap-2 rounded-md border p-1.5',
        prominent ? 'border-foreground/15 bg-card shadow-xs' : 'bg-background/40'
      )}
      data-files-links-card={cardKindAttribute(card)}
      data-files-links-result={prominent ? '' : undefined}
    >
      <Thumbnail card={card} target={target} />
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 items-center gap-1.5 font-medium text-foreground">
          <span className="truncate" title={detail}>
            {name}
          </span>
          {card.type === 'link' && card.kind === 'localhost' ? (
            <LivenessDot liveness={liveness} />
          ) : null}
        </p>
        {location ? (
          <p className="truncate text-muted-foreground" title={detail}>
            {location}
          </p>
        ) : null}
      </div>
      {primary ? (
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="shrink-0"
          data-files-links-primary=""
          onClick={primary.run}
        >
          {primary.label}
        </Button>
      ) : null}
      {secondary ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="shrink-0 text-muted-foreground"
              aria-label={secondary.label}
              data-files-links-secondary=""
              onClick={secondary.run}
            >
              <secondary.icon className="size-3.5" aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {secondary.label}
          </TooltipContent>
        </Tooltip>
      ) : null}
    </li>
  )
}
