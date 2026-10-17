import { useState } from 'react'
import { translate as t } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import {
  failedDispositionLabel,
  type FailedSessionDisposition
} from './finished-session-disposition'
import { UpNextDiagnostic } from './up-next-diagnostic'

/**
 * "Could not close this session · Try again", under a run that still reads Completed. It is as
 * quiet as a caption on purpose: the work succeeded, and only the session's window did not follow.
 * The host's reason stays under Details.
 */
export function FinishedSessionDispositionRetry({
  disposition,
  onRetry,
  scope
}: {
  disposition: FailedSessionDisposition
  /** Asks the host to try again; absent where this surface cannot reach the run. */
  onRetry?: () => Promise<void>
  /** Which surface this is (`header`, `row`), for the Details data attribute. */
  scope: string
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)
  return (
    <div
      className="min-w-0 space-y-1 text-xs text-muted-foreground"
      data-session-disposition-failed={disposition.intent}
    >
      <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
        <span className="min-w-0 break-words">{failedDispositionLabel(disposition.intent)}</span>
        {onRetry && (
          <>
            <span aria-hidden>·</span>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              className="h-5 px-1 text-xs"
              disabled={busy}
              data-session-disposition-retry=""
              onClick={async (event) => {
                // Why: in the sidebar this sits among row surfaces that act on any click they see.
                event.stopPropagation()
                setBusy(true)
                setRefusal(null)
                try {
                  await onRetry()
                } catch (error) {
                  setRefusal(error instanceof Error ? error.message : String(error))
                } finally {
                  setBusy(false)
                }
              }}
            >
              {busy
                ? t('upNext.dispositionRetrying', 'Trying again…')
                : t('upNext.dispositionRetry', 'Try again')}
            </Button>
          </>
        )}
      </p>
      {refusal && (
        <p role="alert" className="min-w-0 break-words text-destructive">
          {refusal}
        </p>
      )}
      <UpNextDiagnostic scope={scope} text={disposition.error} />
    </div>
  )
}
