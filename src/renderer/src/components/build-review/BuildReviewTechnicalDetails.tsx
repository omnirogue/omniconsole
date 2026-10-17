import { translate } from '@/i18n/i18n'

/**
 * The runtime's own words and ids behind a plain message, folded away: the main path says what
 * happened; this keeps what support needs (`agent_prompt_stalled`, `brp_…`, `ctx_…`).
 */
export function BuildReviewTechnicalDetails({
  lines
}: {
  lines: readonly (string | null | undefined | false)[]
}) {
  const shown = [
    ...new Set(lines.filter((line): line is string => typeof line === 'string' && line !== ''))
  ]
  if (shown.length === 0) {
    return null
  }
  return (
    <details className="group text-xs text-muted-foreground" data-build-review-details>
      <summary className="w-fit cursor-pointer select-none rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
        {translate('buildReview.details', 'Details')}
      </summary>
      <div className="mt-1 space-y-0.5 break-all font-mono text-[11px]">
        {shown.map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>
    </details>
  )
}
