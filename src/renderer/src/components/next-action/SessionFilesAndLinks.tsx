import { useMemo, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { FILES_AND_LINKS_PREVIEW_COUNT } from '@/lib/session-files-and-links'
import {
  filesAndLinksView,
  type FilesAndLinksFoldCounts
} from '@/lib/session-files-and-links-result'
import { cn } from '@/lib/utils'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { SessionFilesAndLinksCard } from './SessionFilesAndLinksCard'
import { useSessionOutputs, type SessionOutputs } from './use-session-outputs'

const NO_MESSAGES: readonly NativeChatMessage[] = []

function countPart(count: number, one: string, other: string): string | null {
  if (count === 0) {
    return null
  }
  return count === 1 ? one : other
}

/** "4 PRs · 2 previews · 1 other": what the fold holds, by kind. */
function foldSummary(counts: FilesAndLinksFoldCounts): string {
  return [
    countPart(
      counts.pullRequests,
      translate('filesAndLinks.foldPullRequests_one', '{{count}} PR', { count: 1 }),
      translate('filesAndLinks.foldPullRequests_other', '{{count}} PRs', {
        count: counts.pullRequests
      })
    ),
    countPart(
      counts.previews,
      translate('filesAndLinks.foldPreviews_one', '{{count}} preview', { count: 1 }),
      translate('filesAndLinks.foldPreviews_other', '{{count}} previews', {
        count: counts.previews
      })
    ),
    countPart(
      counts.files,
      translate('filesAndLinks.foldFiles_one', '{{count}} file', { count: 1 }),
      translate('filesAndLinks.foldFiles_other', '{{count}} files', { count: counts.files })
    ),
    countPart(
      counts.other,
      translate('filesAndLinks.foldOther_one', '{{count}} other', { count: 1 }),
      translate('filesAndLinks.foldOther_other', '{{count}} other', { count: counts.other })
    )
  ]
    .filter((part): part is string => part !== null)
    .join(' · ')
}

/**
 * What this session produced that a person may want to open: its one Result (see
 * `filesAndLinksView`), then everything else — pull requests, previews, files, links — folded
 * behind one line. Nothing opens, plays or fetches until a button is pressed.
 */
export function SessionFilesAndLinksView({
  outputs,
  worktreeId,
  hostId
}: {
  outputs: SessionOutputs
  worktreeId: string
  hostId?: string | null
}): React.JSX.Element {
  const [showAll, setShowAll] = useState(false)
  const [open, setOpen] = useState(false)
  const { cards, liveness, target } = outputs
  const view = useMemo(() => filesAndLinksView(cards, liveness), [cards, liveness])
  if (!view.result && view.rest.length === 0) {
    return (
      <p className="text-muted-foreground" data-files-links-empty="">
        {translate('filesAndLinks.empty', 'No files or links yet')}
      </p>
    )
  }
  const shown = showAll ? view.rest : view.rest.slice(0, FILES_AND_LINKS_PREVIEW_COUNT)
  return (
    <div className="space-y-1.5" data-files-links="">
      {view.result ? (
        <ul>
          <SessionFilesAndLinksCard
            card={view.result}
            worktreeId={worktreeId}
            hostId={hostId}
            target={target}
            liveness={view.result.type === 'link' ? liveness.get(view.result.url) : undefined}
            prominent
          />
        </ul>
      ) : null}
      {view.rest.length > 0 ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="h-auto max-w-full justify-start gap-1 px-0 text-xs font-normal text-muted-foreground"
          aria-expanded={open}
          data-files-links-fold=""
          onClick={() => setOpen((value) => !value)}
        >
          <span className="truncate">
            {view.result
              ? translate('filesAndLinks.foldMore', 'More: {{summary}}', {
                  summary: foldSummary(view.counts)
                })
              : foldSummary(view.counts)}
          </span>
          <ChevronDown
            className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-180')}
            aria-hidden
          />
        </Button>
      ) : null}
      {open ? (
        <ul className="space-y-1.5" data-files-links-rest="">
          {shown.map((card) => (
            <SessionFilesAndLinksCard
              key={card.key}
              card={card}
              worktreeId={worktreeId}
              hostId={hostId}
              target={target}
              liveness={card.type === 'link' ? liveness.get(card.url) : undefined}
            />
          ))}
        </ul>
      ) : null}
      {open && view.rest.length > FILES_AND_LINKS_PREVIEW_COUNT ? (
        <Button
          type="button"
          variant="link"
          size="xs"
          className="h-auto px-0 text-xs text-muted-foreground"
          aria-expanded={showAll}
          onClick={() => setShowAll((value) => !value)}
        >
          {showAll
            ? translate('filesAndLinks.showFewer', 'Show fewer')
            : translate('filesAndLinks.showAll', 'Show all {{count}}', { count: view.rest.length })}
        </Button>
      ) : null}
    </div>
  )
}

/** The same list for a mount that has not built the session's outputs itself. */
export function SessionFilesAndLinks({
  worktreeId,
  hostId,
  messages = NO_MESSAGES,
  active
}: {
  worktreeId: string
  hostId?: string | null
  messages?: readonly NativeChatMessage[]
  active: boolean
}): React.JSX.Element {
  const outputs = useSessionOutputs({ worktreeId, hostId, messages, active })
  return <SessionFilesAndLinksView outputs={outputs} worktreeId={worktreeId} hostId={hostId} />
}
