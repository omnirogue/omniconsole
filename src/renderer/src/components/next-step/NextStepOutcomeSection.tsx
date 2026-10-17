import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * One row of the Next actions stack: "Title · value" in one line and the one control that
 * changes it. The row's hint shows only while the row is hovered or focused, so an untouched
 * form reads as three short lines. Children are what the person chose, one line each.
 */
export function NextStepOutcomeSection({
  id,
  title,
  value,
  hint,
  action,
  children,
  className
}: {
  id: string
  title: string
  value?: ReactNode
  hint?: ReactNode
  action?: ReactNode
  children?: ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <section className={cn('group/row space-y-1.5', className)} data-next-step-section={id}>
      <div className="flex min-h-7 items-center justify-between gap-3">
        <p className="min-w-0 truncate text-xs">
          <span className="font-medium">{title}</span>
          {value ? (
            <span className="text-muted-foreground">
              {' · '}
              <span data-next-step-summary={id}>{value}</span>
            </span>
          ) : null}
        </p>
        {action ? <div className="flex shrink-0 items-center gap-1">{action}</div> : null}
      </div>
      {hint ? (
        // Why: the line keeps its height so the form never jumps when a hint appears.
        <p
          className="h-4 truncate text-[11px] leading-4 text-muted-foreground opacity-0 transition-opacity group-focus-within/row:opacity-100 group-hover/row:opacity-100 motion-reduce:transition-none"
          data-next-step-hint={id}
        >
          {hint}
        </p>
      ) : null}
      {children}
    </section>
  )
}
