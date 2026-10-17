import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { translate } from '@/i18n/i18n'
import type { SessionBulkOutcome } from './session-bulk-outcome'

export function SessionBulkResults({
  action,
  outcomes,
  pending,
  onDismiss
}: {
  action: string
  outcomes: readonly SessionBulkOutcome[]
  pending: boolean
  onDismiss: () => void
}) {
  const succeeded = outcomes.filter((outcome) => outcome.ok && !outcome.skipped).length
  const skipped = outcomes.filter((outcome) => outcome.skipped).length
  const refused = outcomes.filter((outcome) => !outcome.ok).length
  const label = translate('sessions.bulkResults', '{{action}} results', { action })
  return (
    <div className="space-y-1 text-xs">
      <p role="status">
        {pending
          ? translate('sessions.pausing', 'Pausing selected sessions…')
          : translate(
              'sessions.bulkResultCounts',
              '{{action}}: {{succeeded}} succeeded · {{skipped}} skipped · {{refused}} not confirmed',
              { action, succeeded, skipped, refused }
            )}
      </p>
      <div className="flex items-center gap-1">
        {outcomes.length > 0 ? (
          <Popover>
            <PopoverTrigger asChild>
              <Button size="xs" variant="ghost" aria-label={label}>
                {translate('sessions.bulkResultDetails', 'Details ({{count}})', {
                  count: outcomes.length
                })}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-80 max-w-[calc(100vw-2rem)] p-3">
              <div
                role="region"
                aria-label={label}
                tabIndex={0}
                className="max-h-60 space-y-2 overflow-y-auto break-words text-xs scrollbar-sleek"
              >
                {outcomes.map((outcome) => (
                  <p key={outcome.key}>
                    {outcome.label}: {outcome.message}
                  </p>
                ))}
              </div>
            </PopoverContent>
          </Popover>
        ) : null}
        <Button size="xs" variant="ghost" onClick={onDismiss}>
          {translate('sessions.dismissBulkResults', 'Dismiss results')}
        </Button>
      </div>
    </div>
  )
}
