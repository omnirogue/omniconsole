import { translate } from '@/i18n/i18n'
import type { SessionFolderTally } from '@/lib/session-folder-rollup'
import { cn } from '@/lib/utils'

/** A project's line: "needs you N · working N", both always shown so the eye finds them. */
export function SessionProjectRollup({ tally }: { tally: SessionFolderTally }): React.JSX.Element {
  const needsYou = translate('projects.rollup.needsYou', 'needs you {{count}}', {
    count: tally.needsYou
  })
  const working = translate('projects.rollup.working', 'working {{count}}', {
    count: tally.working
  })
  const summary = `${needsYou} · ${working}`
  return (
    <span
      data-session-project-rollup=""
      title={summary}
      aria-label={summary}
      className="min-w-0 shrink truncate text-[10px] tabular-nums text-muted-foreground"
    >
      <span
        data-session-project-rollup-state="needsYou"
        className={cn(tally.needsYou > 0 && 'font-semibold text-agent-question-text')}
      >
        {needsYou}
      </span>
      {' · '}
      <span data-session-project-rollup-state="working">{working}</span>
    </span>
  )
}
