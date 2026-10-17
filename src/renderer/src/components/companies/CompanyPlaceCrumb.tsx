import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { CompanyMark } from './CompanyMark'
import { DivisionMark } from './DivisionMark'
import { useCompanyPlace } from './use-company-place'

/**
 * "Company › Department" for the workspace a session runs in — the same marks the
 * Companies tree draws — so a person always sees where a conversation belongs.
 * Renders nothing outside every company folder.
 */
export function CompanyPlaceCrumb({
  worktreeId,
  className
}: {
  worktreeId: string | null | undefined
  className?: string
}): React.JSX.Element | null {
  const place = useCompanyPlace(worktreeId)
  if (!place) {
    return null
  }
  return (
    <span
      data-company-place={place.company.slug}
      data-company-domain={place.domain?.name ?? ''}
      className={cn('inline-flex min-w-0 items-center gap-1 align-middle', className)}
    >
      <CompanyMark
        company={place.company.slug}
        name={place.company.name}
        className="size-3.5 rounded-sm"
        decorative
      />
      <span className="truncate">{place.company.name}</span>
      {place.domain ? (
        <>
          <ChevronRight className="size-3 shrink-0 opacity-60" aria-hidden />
          <DivisionMark name={place.domain.name} className="size-3.5 rounded-sm" />
          <span className="truncate">{place.domain.name}</span>
        </>
      ) : null}
    </span>
  )
}
