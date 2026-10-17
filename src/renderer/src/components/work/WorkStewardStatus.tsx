import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useSidebarSessions } from '@/components/sidebar/session-folders/use-sidebar-sessions'
import { translate } from '@/i18n/i18n'
import { activateSidebarSession } from '@/lib/activate-sidebar-session'
import { sessionManagePaneKey } from '@/lib/session-manage-sidebar-rows'
import { describeOrganizationTime } from '@/lib/session-organization-describe'
import { undoOrganizationChangesWithNotice } from '@/lib/session-organization-undo-notice'
import {
  markStewardFinishedSeen,
  readStewardFinished,
  readStewardFinishedSeenAt,
  refreshSessionStewardStatus,
  useSessionStewardStatus
} from '@/lib/session-steward-client'
import type {
  SessionStewardStatus,
  StewardResultCard
} from '../../../../shared/session-steward-status'
import { stewardFinishedView, stewardMoveCounts } from './steward-activity-model'

const ROW_LIMIT = 5
const FINISHED_WINDOW_MS = 7 * 24 * 60 * 60_000

function MovesLine({ status }: { status: SessionStewardStatus }): React.JSX.Element | null {
  const counts = stewardMoveCounts(status.activity)
  const parts = [
    counts.yes
      ? translate('work.steward.moves.yes', 'said yes {{count}}', { count: counts.yes })
      : null,
    counts.nudge
      ? translate('work.steward.moves.nudge', 'nudged {{count}}', { count: counts.nudge })
      : null,
    counts.ask
      ? translate('work.steward.moves.ask', 'asked {{count}}', { count: counts.ask })
      : null,
    counts.archive
      ? translate('work.steward.moves.archive', 'archived {{count}}', { count: counts.archive })
      : null,
    counts.close
      ? translate('work.steward.moves.close', 'closed {{count}} blank', { count: counts.close })
      : null,
    counts.refused
      ? translate('work.steward.moves.refused', 'left {{count}} for you', { count: counts.refused })
      : null
  ].filter((part): part is string => part !== null)
  return (
    <p className="text-xs text-muted-foreground" data-steward-moves="">
      {parts.length > 0
        ? translate(
            'work.steward.moves.line',
            'Steward, last 24 h: {{moves}} · prompts sent today: {{today}}',
            { moves: parts.join(' · '), today: status.prompts.today }
          )
        : translate(
            'work.steward.moves.none',
            'The steward has not moved anything in the last 24 hours.'
          )}
    </p>
  )
}

/** Sessions the steward tried and could not move, and working ones that went silent. */
function StalledRows({ status }: { status: SessionStewardStatus }): React.JSX.Element | null {
  const sessions = useSidebarSessions()
  const open = (paneKey: string): void => {
    const session = sessions.find((entry) => sessionManagePaneKey(entry) === paneKey)
    void (session ? activateSidebarSession(session) : Promise.resolve(false)).then((opened) => {
      if (!opened) {
        toast.error(
          translate(
            'work.openSessionFailed',
            'This session could not be opened; check its workspace.'
          )
        )
      }
    })
  }
  const rows = [
    ...status.stalled.map((entry) => ({
      paneKey: entry.paneKey,
      title: entry.title,
      detail: translate('work.steward.stalledReason', 'Stalled: {{reason}}', {
        reason: entry.reason
      })
    })),
    ...status.silent.map((entry) => ({
      paneKey: entry.paneKey,
      title: entry.title,
      detail: translate(
        'work.steward.silent',
        'Working, no output for {{minutes}} min; a restart may help',
        {
          minutes: entry.minutes
        }
      )
    }))
  ]
  if (rows.length === 0) {
    return null
  }
  return (
    <ul className="space-y-1.5" aria-label={translate('work.steward.stalledTitle', 'Stalled')}>
      {rows.slice(0, ROW_LIMIT).map((row) => (
        <li
          key={`${row.paneKey}:${row.detail}`}
          className="flex flex-wrap items-center gap-2 rounded-lg border bg-card px-3 py-2"
          data-steward-stalled={row.paneKey}
        >
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{row.title}</div>
            <div className="truncate text-xs text-muted-foreground" title={row.detail}>
              {row.detail}
            </div>
          </div>
          <Button size="xs" variant="outline" onClick={() => open(row.paneKey)}>
            {translate('work.steward.open', 'Open')}
          </Button>
        </li>
      ))}
      {rows.length > ROW_LIMIT ? (
        <li className="text-xs text-muted-foreground">
          {translate(
            'work.steward.moreStalled',
            '{{count}} more; omni session list --state stalled lists them all.',
            {
              count: rows.length - ROW_LIMIT
            }
          )}
        </li>
      ) : null}
    </ul>
  )
}

function FinishedCard({
  card,
  unseen,
  onUndone
}: {
  card: StewardResultCard
  unseen: boolean
  onUndone: () => void
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const details = [
    card.pullRequests.length
      ? translate('work.steward.card.prs', 'Pull requests: {{count}}', {
          count: card.pullRequests.length
        })
      : null,
    card.changedFiles.length
      ? translate('work.steward.card.files', 'Changed files: {{count}}', {
          count: card.changedFiles.length
        })
      : null
  ].filter((part): part is string => part !== null)
  return (
    <li
      className={`rounded-lg border bg-card px-3 py-2 ${unseen ? '' : 'opacity-70'}`}
      data-steward-finished={card.key}
      data-steward-unseen={unseen ? 'true' : 'false'}
    >
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{card.title}</div>
          <div className="truncate text-xs text-muted-foreground">
            {translate(
              'work.steward.card.label',
              'Finished, not verified · {{evidence}} · archived {{when}}',
              {
                evidence: card.evidence,
                when: describeOrganizationTime(
                  new Date(card.archivedAt ?? card.builtAt).toISOString()
                )
              }
            )}
          </div>
        </div>
        {card.opId ? (
          <Button
            size="xs"
            variant="outline"
            disabled={busy}
            onClick={() => {
              setBusy(true)
              void undoOrganizationChangesWithNotice([card.opId!], 'work')
                .then(onUndone)
                .finally(() => setBusy(false))
            }}
          >
            {translate('work.steward.undo', 'Undo')}
          </Button>
        ) : null}
      </div>
      {card.lastReply ? (
        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground" title={card.lastReply}>
          {card.lastReply}
        </p>
      ) : null}
      {details.length > 0 || card.pullRequests.length > 0 ? (
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {details.length > 0 ? <span>{details.join(' · ')}</span> : null}
          {card.pullRequests.slice(0, 3).map((pr) => (
            <button
              key={pr.url}
              type="button"
              className="underline underline-offset-2 hover:text-foreground"
              onClick={() => void window.api.shell.openUrl(pr.url)}
            >
              {`${pr.repo}#${pr.number}`}
            </button>
          ))}
        </div>
      ) : null}
    </li>
  )
}

/** Result cards of what the steward archived, the ones since the person last looked first. */
function FinishedCards(): React.JSX.Element | null {
  const [cards, setCards] = useState<StewardResultCard[] | null>(null)
  const [seenAt, setSeenAt] = useState(() => readStewardFinishedSeenAt())
  const load = useCallback(() => {
    void readStewardFinished(Date.now() - FINISHED_WINDOW_MS).then(setCards)
  }, [])
  useEffect(load, [load])
  const view = useMemo(() => stewardFinishedView(cards ?? [], seenAt), [cards, seenAt])
  if (!cards || cards.length === 0) {
    return null
  }
  const shown = [...view.unseen, ...view.seen].slice(0, ROW_LIMIT)
  return (
    <div data-steward-finished-count={view.unseen.length}>
      <div className="mb-1 flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold">
          {translate('work.steward.finishedTitle', 'Finished since you last looked · {{count}}', {
            count: view.unseen.length
          })}
        </h3>
        {view.unseen.length > 0 ? (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              const now = Date.now()
              markStewardFinishedSeen(now)
              setSeenAt(now)
            }}
          >
            {translate('work.steward.markSeen', 'Mark seen')}
          </Button>
        ) : null}
      </div>
      <ul className="space-y-1.5">
        {shown.map((card) => (
          <FinishedCard
            key={card.key}
            card={card}
            unseen={view.unseen.includes(card)}
            onUndone={() => {
              load()
              void refreshSessionStewardStatus()
            }}
          />
        ))}
      </ul>
    </div>
  )
}

/** The steward's own report in Work: what it did, what it could not move, what it finished. */
export function WorkStewardStatus(): React.JSX.Element | null {
  const status = useSessionStewardStatus()
  if (!status) {
    return null
  }
  return (
    <div className="mb-2 space-y-2" data-work-steward-status="">
      {status.off ? (
        <p className="text-xs text-muted-foreground">{status.off}</p>
      ) : (
        <MovesLine status={status} />
      )}
      <StalledRows status={status} />
      <FinishedCards />
    </div>
  )
}
