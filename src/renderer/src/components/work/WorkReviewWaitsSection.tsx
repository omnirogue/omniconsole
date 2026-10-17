import { SessionDataStatusLine } from '@/components/session-data-status'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useOpenInPane } from '@/components/open-in-pane-context'
import { openArtifactInBrowser } from '@/components/artifacts/artifact-link-actions'
import { translate } from '@/i18n/i18n'
import { openLinkedSession } from '@/lib/open-linked-session'
import { cn } from '@/lib/utils'
import {
  REVIEW_WAIT_OLD_MS,
  reviewWaitChip,
  reviewWaitHostAway,
  type ReviewWaitItem
} from '../../../../shared/artifact-review-waits'
import { WorkSectionTitle } from './WorkSectionTitle'
import { useReviewWaits } from './use-review-waits'

function age(iso: string | null, now: number): string | null {
  const at = iso ? Date.parse(iso) : Number.NaN
  if (!Number.isFinite(at)) {
    return null
  }
  const minutes = Math.max(0, Math.round((now - at) / 60_000))
  if (minutes < 60) {
    return translate('decisions.minutesAgo', '{{count}} min ago', { count: minutes })
  }
  const hours = Math.round(minutes / 60)
  return hours < 48
    ? translate('decisions.hoursAgo', '{{count}} h ago', { count: hours })
    : translate('decisions.daysAgo', '{{count}} days ago', { count: Math.round(hours / 24) })
}

function chipTone(state: string | undefined): string {
  if (state === 'waiting' || state === 'waking' || state === 'awake') {
    return 'border-status-info-border bg-status-info-background text-status-info'
  }
  return state === 'stalled'
    ? 'border-status-warning-border bg-status-warning-background text-status-warning'
    : 'border-border bg-muted text-muted-foreground'
}

function asker(item: ReviewWaitItem): string {
  if (item.session?.local) {
    return translate('work.reviewWaits.askedHere', 'asked by a session on this computer')
  }
  const who = item.publishedBy?.isYou
    ? translate('work.reviewWaits.you', 'you')
    : item.publishedBy?.name || item.publishedBy?.email
  return who
    ? translate('work.reviewWaits.askedBy', 'asked by {{who}}', { who })
    : translate('work.reviewWaits.askedUnknown', 'asked by a session')
}

function ReviewWaitRow({ item, now }: { item: ReviewWaitItem; now: number }): React.JSX.Element {
  const openPage = useOpenInPane(openArtifactInBrowser)
  const chip = reviewWaitChip(item)
  const updated = item.updatedAt ? Date.parse(item.updatedAt) : Number.NaN
  const old = Number.isFinite(updated) && now - updated > REVIEW_WAIT_OLD_MS
  const session = item.session
  const meta = [asker(item), age(item.updatedAt, now)].filter(Boolean).join(' · ')
  return (
    <li className="flex flex-wrap items-center gap-2 rounded-lg border bg-card px-3 py-2">
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="truncate text-sm font-medium">{item.title}</p>
        {item.question ? (
          <p className="truncate text-xs text-muted-foreground">{item.question}</p>
        ) : null}
        {/* As OmniOS's list: the page's short version in four lines; all of it on hover. */}
        {item.summary ? (
          <p className="line-clamp-4 whitespace-pre-line text-xs" title={item.summary}>
            {item.summary}
          </p>
        ) : null}
        <p className="text-[11px] text-muted-foreground">{meta}</p>
      </div>
      {chip ? (
        <Badge
          variant="outline"
          className={cn('max-w-full truncate', chipTone(session?.state))}
          title={session?.detail ?? chip}
        >
          {chip}
        </Badge>
      ) : null}
      {reviewWaitHostAway(session) ? (
        <Badge variant="outline">
          {translate('work.reviewWaits.offline', 'Its computer is not checking in')}
        </Badge>
      ) : null}
      {old ? <Badge variant="outline">{translate('work.reviewWaits.old', 'old')}</Badge> : null}
      {item.shareUrl ? (
        <Button size="xs" variant="outline" onClick={() => openPage(item.shareUrl)}>
          {translate('work.reviewWaits.openPage', 'Open page')}
        </Button>
      ) : null}
      {session?.local && session.ledgerId ? (
        <Button
          size="xs"
          variant="ghost"
          onClick={() =>
            openLinkedSession({
              sessionLedgerId: session.ledgerId!,
              ...(session.paneKey ? { paneKey: session.paneKey } : {}),
              ...(session.nativeSessionId ? { nativeSessionId: session.nativeSessionId } : {})
            })
          }
        >
          {translate('work.reviewWaits.openSession', 'Open session')}
        </Button>
      ) : null}
    </li>
  )
}

/** Under Needs You — Questions: pages waiting for a decision, with where each asking session is. */
export function WorkReviewWaitsSection({
  embedded = false
}: {
  embedded?: boolean
}): React.JSX.Element | null {
  const { items, status, issue, lastSuccessAt, readAt } = useReviewWaits()
  if (status === 'healthy-empty') {
    return embedded ? (
      <p role="status" className="p-3 text-sm text-muted-foreground">
        {translate('commandCenter.reviewWaits.empty', 'No pages are waiting for a decision.')}
      </p>
    ) : null
  }
  return (
    <section
      aria-label={translate('work.reviewWaits.title', 'Waiting for a decision')}
      data-work-review-waits={items.length}
    >
      <WorkSectionTitle
        title={translate('work.reviewWaits.title', 'Waiting for a decision')}
        sub={translate('work.reviewWaits.count', '{{count}} pages', { count: items.length })}
      />
      <SessionDataStatusLine status={status} issue={issue} lastSuccessAt={lastSuccessAt} />
      <ul className="space-y-1.5">
        {items.map((item) => (
          <ReviewWaitRow key={item.slug} item={item} now={readAt} />
        ))}
      </ul>
    </section>
  )
}
