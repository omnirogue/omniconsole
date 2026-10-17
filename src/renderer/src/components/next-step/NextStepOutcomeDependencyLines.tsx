import { translate } from '@/i18n/i18n'
import type { SessionOutcomeSet } from '../../../../shared/session-outcome-types'
import {
  sessionOutcomeDependencies,
  type SessionOutcomeBlocker
} from '../../../../shared/session-outcome-dependencies'

function blockerText(blocker: SessionOutcomeBlocker): string {
  if (blocker.cause === 'abandoned') {
    return translate('nextStep.dependencyAbandoned', '{{title}} was abandoned', {
      title: blocker.title
    })
  }
  if (blocker.cause === 'missing') {
    return translate('nextStep.dependencyMissing', '{{title}} is not in the plan', {
      title: blocker.title
    })
  }
  return translate('nextStep.dependencyFailed', '{{title}} failed', { title: blocker.title })
}

/** One short line per outcome still waiting on, or blocked by, the outcomes it depends on. */
export function NextStepOutcomeDependencyLines({
  outcomeSet
}: {
  outcomeSet: Pick<SessionOutcomeSet, 'outcomes' | 'removals'> | null | undefined
}): React.JSX.Element | null {
  const lines = sessionOutcomeDependencies(outcomeSet).filter(
    (line) => line.state === 'waiting' || line.state === 'blocked'
  )
  if (lines.length === 0) {
    return null
  }
  return (
    <ul className="space-y-0.5 text-xs" data-next-step-outcome-dependencies>
      {lines.map((line) => (
        <li
          key={line.outcomeId}
          data-outcome-dependency={line.state}
          className={line.state === 'blocked' ? 'text-destructive' : 'text-muted-foreground'}
        >
          {line.state === 'blocked'
            ? translate('nextStep.dependencyCantRun', "{{title}}: can't run, {{reasons}}", {
                title: line.title,
                reasons: line.blockedBy.map(blockerText).join(', ')
              })
            : translate('nextStep.dependencyWaiting', '{{title}}: waiting on {{names}}', {
                title: line.title,
                names: line.waitingOn.join(', ')
              })}
        </li>
      ))}
    </ul>
  )
}
