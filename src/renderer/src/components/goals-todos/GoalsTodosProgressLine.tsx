import type { ReactNode } from 'react'
import {
  goalsTodosProgressLabel,
  goalsTodosStepLabel,
  type GoalsTodosProgress
} from './goals-todos-text'

/** "3 of 7 done" with a slim bar, then the step in progress on its own line. */
export function GoalsTodosProgressLine({
  progress,
  showStep = true,
  trailing
}: {
  progress: GoalsTodosProgress
  /** Off when the checklist below already highlights the step in progress. */
  showStep?: boolean
  /** A control at the end of the bar's line, such as a show/hide toggle. */
  trailing?: ReactNode
}): React.JSX.Element {
  const percent = progress.total > 0 ? Math.round((progress.completed / progress.total) * 100) : 0
  const label = goalsTodosProgressLabel(progress)
  const step = showStep ? goalsTodosStepLabel(progress) : null
  return (
    <>
      <div className="mt-1 flex min-w-0 items-center gap-2">
        <div
          className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={progress.total}
          aria-valuenow={progress.completed}
          aria-label={label}
        >
          <div className="h-full rounded-full bg-emerald-500" style={{ width: `${percent}%` }} />
        </div>
        <span className="shrink-0 text-muted-foreground">{label}</span>
        {trailing}
      </div>
      {step ? (
        <p className="min-w-0 truncate" title={step}>
          {step}
        </p>
      ) : null}
    </>
  )
}
