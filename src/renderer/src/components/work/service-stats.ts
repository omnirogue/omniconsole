import { translate } from '@/i18n/i18n'
import {
  NEGATIVE_SENTIMENT_WARN_PCT,
  unansweredToday,
  type CsCompany
} from '../../../../shared/console-scorecard-contract'
import { statNumber as number, type Stat } from './stats-model'

/**
 * Customer service: received → replied → backlog → response times → sentiment.
 * A percentage with no sample behind it is not shown at all.
 */

export function serviceStats(service: CsCompany | undefined): Stat[] {
  const today = service?.today
  const week = service?.week
  const detail = service?.detail
  const backlog = service?.backlog
  const sentiment = service?.sentiment
  const negative = number(sentiment?.negative_pct)
  const unanswered = unansweredToday(today)
  const needsHuman = number(backlog?.needs_human_now) ?? number(today?.needs_human)
  const over7d = (value: number | null): string | undefined =>
    value === null ? undefined : `${value.toLocaleString('en-US')} over 7d`
  return [
    {
      id: 'created',
      label: translate('work.service.createdToday', 'Created today'),
      value: number(today?.created),
      kind: 'count',
      caption: over7d(number(week?.created))
    },
    {
      id: 'replied',
      label: translate('work.service.repliedToday', 'Replied today'),
      value: number(today?.replied),
      kind: 'count',
      caption: over7d(number(detail?.replied_7d) ?? number(week?.replied))
    },
    {
      id: 'unanswered',
      label: translate('work.service.unansweredToday', 'Unanswered today'),
      value: unanswered,
      kind: 'count',
      tone: unanswered !== null && unanswered > 0 ? 'warn' : 'neutral',
      caption: translate('work.service.createdLessRepliedAndSpam', 'created less replied and spam')
    },
    {
      id: 'backlog',
      label: translate('work.service.openBacklog', 'Open backlog'),
      value: number(backlog?.open_now),
      kind: 'count',
      tone: number(backlog?.open_now) ? 'warn' : 'neutral',
      caption: backlog?.oldest_open ? `oldest open ${backlog.oldest_open.slice(0, 10)}` : undefined
    },
    {
      id: 'needs_human',
      label: translate('work.service.needsAHumanNow', 'Needs a human now'),
      // Why one binding: the tone read only the backlog while the value fell back to
      // today's count, so a real three people waiting rendered calm.
      value: needsHuman,
      kind: 'count',
      tone: needsHuman !== null && needsHuman > 0 ? 'warn' : 'neutral'
    },
    {
      id: 'response_avg',
      label: translate('work.service.avgFirstReply', 'Avg first reply'),
      value: number(detail?.response_hours_avg),
      kind: 'hours',
      caption: translate('work.service.firstReply7d', 'first reply, 7d')
    },
    {
      id: 'response_median',
      label: translate('work.service.medianFirstReply', 'Median first reply'),
      value: number(detail?.response_hours_median),
      kind: 'hours',
      caption: translate('work.service.firstReply7d', 'first reply, 7d')
    },
    {
      id: 'resolution_avg',
      label: translate('work.service.avgResolution', 'Avg resolution'),
      value: number(detail?.resolution_hours_avg),
      kind: 'hours',
      caption:
        number(detail?.resolved_7d) === null
          ? undefined
          : `${number(detail?.resolved_7d)} resolved 7d`
    },
    {
      id: 'negative',
      label: translate('work.service.negativeSentiment', 'Negative sentiment'),
      value: negative,
      kind: 'percent',
      tone: negative !== null && negative >= NEGATIVE_SENTIMENT_WARN_PCT ? 'warn' : 'neutral',
      caption:
        number(sentiment?.sample) === null
          ? undefined
          : `${number(sentiment?.sample)} tickets sampled`,
      withheld:
        negative === null && service !== undefined
          ? 'No sentiment sample was taken for this desk.'
          : undefined
    }
  ]
}

/** Operations for one company: what is live, what is stuck, what shipped. */
