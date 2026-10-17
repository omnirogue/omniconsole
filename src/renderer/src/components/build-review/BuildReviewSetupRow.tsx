import type { ReactNode } from 'react'
import { Label } from '@/components/ui/label'

/**
 * One quiet setup row, as the Council and Discover composers draw theirs: a muted label column
 * beside the controls, stacking on narrow panes. `group` names the controls for assistive tech
 * where the row holds several of them.
 */
export function BuildReviewSetupRow({
  label,
  htmlFor,
  labelId,
  group = false,
  children
}: {
  label: string
  htmlFor?: string
  /** Lets a control inside name itself after this label (`aria-labelledby`). */
  labelId?: string
  group?: boolean
  children: ReactNode
}) {
  return (
    <div
      className="grid gap-2 sm:grid-cols-[7rem_minmax(0,1fr)] sm:items-start"
      {...(group ? { role: 'group', 'aria-label': label } : {})}
    >
      {htmlFor ? (
        <Label htmlFor={htmlFor} className="pt-1.5 text-xs font-medium text-muted-foreground">
          {label}
        </Label>
      ) : (
        <p id={labelId} className="pt-1.5 text-xs font-medium text-muted-foreground">
          {label}
        </p>
      )}
      <div className="min-w-0 space-y-2">{children}</div>
    </div>
  )
}
