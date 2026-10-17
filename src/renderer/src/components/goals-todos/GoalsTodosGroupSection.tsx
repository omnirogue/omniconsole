import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { GoalsTodosGroupKind, GoalsTodosRow } from './goals-todos-rows'
import { GoalsTodosRowItem } from './GoalsTodosRowItem'

function groupLabel(kind: GoalsTodosGroupKind, count: number): string {
  switch (kind) {
    case 'needs-you':
      return translate('goalsTodos.needsYou', 'Needs you ({{count}})', { count })
    case 'in-progress':
      return translate('goalsTodos.inProgress', 'In progress ({{count}})', { count })
    case 'idle':
      return translate('goalsTodos.idle', 'Done or idle ({{count}})', { count })
  }
}

/** One attention group; empty groups are not shown at all. */
export function GoalsTodosGroupSection({
  kind,
  rows,
  now,
  hiddenCount = 0,
  defaultOpen = true
}: {
  kind: GoalsTodosGroupKind
  rows: readonly GoalsTodosRow[]
  now: number
  /** Rows left out of a recent-only group, said out loud rather than silently dropped. */
  hiddenCount?: number
  defaultOpen?: boolean
}): React.JSX.Element | null {
  const [open, setOpen] = useState(defaultOpen)
  if (rows.length === 0) {
    return null
  }
  return (
    <section className="mb-2" data-goals-todos-group={kind}>
      <button
        type="button"
        className="flex w-full items-center gap-1 px-2 py-1 text-left text-xs font-medium text-muted-foreground hover:text-foreground"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronDown className={cn('size-3.5 transition-transform', !open && '-rotate-90')} />
        {groupLabel(kind, rows.length + hiddenCount)}
      </button>
      {open ? (
        <>
          <ul className="space-y-0.5">
            {rows.map((row) => (
              <GoalsTodosRowItem key={row.key} row={row} now={now} />
            ))}
          </ul>
          {hiddenCount > 0 ? (
            <p className="px-2 pt-1 text-xs text-muted-foreground">
              {translate('goalsTodos.recentOnly', 'Showing the {{count}} most recent.', {
                count: rows.length
              })}
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  )
}
