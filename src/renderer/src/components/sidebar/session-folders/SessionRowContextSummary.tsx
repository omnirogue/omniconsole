import { translate } from '@/i18n/i18n'
import type { SessionCompactContext } from '../../../../../shared/session-compact-context'

export function SessionRowContextSummary({
  context
}: {
  context?: SessionCompactContext | null
}): React.JSX.Element | null {
  if (!context) {
    return null
  }
  const lines = [
    {
      key: 'goal',
      label: translate('components.sessionHoverCard.goal', 'Goal'),
      text: context.goal
    },
    {
      key: 'request',
      label: translate('components.sessionHoverCard.latestRequest', 'Current request'),
      text: context.latestRequest === context.goal ? null : context.latestRequest
    },
    {
      key: 'update',
      label: translate('components.sessionHoverCard.latestUpdate', 'Latest update'),
      text: context.latestUpdate
    },
    {
      key: 'next',
      label: translate('components.sessionHoverCard.nextStep', 'Next step'),
      text: context.nextStep
    }
  ].filter((line) => line.text)
  if (lines.length === 0) {
    return null
  }
  return (
    <dl className="space-y-2 break-words" data-session-context="">
      {lines.map(({ key, label, text }) => (
        <div key={key}>
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="text-foreground leading-relaxed">{text}</dd>
        </div>
      ))}
    </dl>
  )
}
