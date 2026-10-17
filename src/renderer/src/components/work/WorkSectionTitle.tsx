import type React from 'react'

/** One heading per Work section: what it is, how much of it there is, and one way in. */
export function WorkSectionTitle({
  title,
  sub,
  action
}: {
  title: string
  sub?: string
  action?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
      <div className="flex items-baseline gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        {sub ? <span className="text-[11px] text-muted-foreground">{sub}</span> : null}
      </div>
      {action}
    </div>
  )
}
