import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { withoutIdentifiers } from './build-review-plain-text'
import { BuildReviewTechnicalDetails } from './BuildReviewTechnicalDetails'

const RPC_ERROR_PREFIX = /^\w*Error:\s*/
const RUN_NOT_FOUND = /Build \+ Review pipeline \S+ was not found/

/**
 * A run a tab points at that could not be read. A run the host no longer has (a tab restored
 * from before runs were saved) says so and offers nothing to retry; any other failure says what
 * went wrong in words with a Retry. The host's own line stays under Details either way.
 */
export function BuildReviewReadFailure({
  message,
  onRetry
}: {
  message: string
  onRetry: () => void
}) {
  // The host no longer has this run at all: nothing to retry.
  const gone = RUN_NOT_FOUND.test(message)
  return (
    <div
      role={gone ? 'status' : 'alert'}
      data-build-review-read-failure={gone ? 'gone' : 'failed'}
      className={
        gone
          ? 'mx-auto mb-4 max-w-4xl space-y-1 rounded-md border p-3 text-sm text-muted-foreground'
          : 'mx-auto mb-4 flex max-w-4xl flex-wrap items-center gap-2 rounded-md border border-destructive p-3 text-sm text-destructive'
      }
    >
      <div className="min-w-0 flex-1 space-y-1 break-words">
        {gone ? (
          <p>{translate('buildReview.readFailure.gone', 'This run is no longer available.')}</p>
        ) : (
          <>
            <p>{withoutIdentifiers(message.replace(RPC_ERROR_PREFIX, ''))}</p>
            <p>
              {translate(
                'localWorkflow.buildReviewRunUnavailableHelp',
                'Run state unavailable. Check active workers or terminals in this workspace before starting another Build + Review.'
              )}
            </p>
          </>
        )}
        <BuildReviewTechnicalDetails lines={[message]} />
      </div>
      {!gone && (
        <Button size="sm" variant="outline" onClick={onRetry}>
          {translate('localWorkflow.retryBuildReview', 'Retry')}
        </Button>
      )}
    </div>
  )
}
