import { useContext, useState } from 'react'
import { translate as t } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { resumeSessionOutcomes } from '@/components/next-step/next-step-outcome-client'
import {
  getSessionChain,
  publishSessionChains,
  setSessionChainEntry
} from '@/lib/session-chain-registry'
import { cn } from '@/lib/utils'
import type { UpNextPersonBlock, UpNextView } from '../../../../shared/up-next-types'
import { UpNextOutcomeContext } from './up-next-outcome-context'
import { sendStatus } from './up-next-person-lines'

/**
 * Try again is the host's own Resume: it clears the held send's failure, gives a refused person a
 * fresh key, and sends again. The composer's next read shows what came of it.
 */
export async function retryPersonSend(chainId: string): Promise<void> {
  const chain = getSessionChain(chainId)
  if (!chain?.outcomeSet) {
    throw new Error(
      t(
        'upNext.dispositionRetryUnavailable',
        'This run is not loaded on this device yet. Try again in a moment.'
      )
    )
  }
  setSessionChainEntry(
    await resumeSessionOutcomes({
      id: chain.id,
      owner: chain,
      expectedRevision: chain.outcomeSet.revision
    })
  )
  publishSessionChains()
}

/** The one status line under a sent Person block, and the way to try a failed send again. */
export function PersonSendStatus({
  block,
  view
}: {
  block: UpNextPersonBlock
  view: UpNextView
}): React.JSX.Element | null {
  const chainId = useContext(UpNextOutcomeContext)
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)
  const status = sendStatus(block, view)
  if (!status) {
    return null
  }
  // Why both: a send that reached only some of its people is tried again for the rest.
  const failed = status.kind === 'failed' || status.kind === 'part-sent'
  return (
    <div className="min-w-0 space-y-1 px-3 pb-2 text-xs" data-up-next-send-status={status.kind}>
      <p
        aria-live="polite"
        title={status.title}
        className={cn(
          'flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 break-words',
          failed
            ? 'text-destructive'
            : status.kind === 'changes'
              ? 'text-status-warning'
              : 'text-muted-foreground'
        )}
      >
        <span className="min-w-0 break-words">{status.text}</span>
        {failed && chainId && (
          <Button
            type="button"
            size="xs"
            variant="outline"
            className="h-5 px-1.5 text-xs"
            disabled={busy}
            data-up-next-send-retry=""
            onClick={async () => {
              setBusy(true)
              setRefusal(null)
              try {
                await retryPersonSend(chainId)
              } catch (error) {
                setRefusal(error instanceof Error ? error.message : String(error))
              } finally {
                setBusy(false)
              }
            }}
          >
            {busy
              ? t('upNext.sendStatus.retrying', 'Trying again…')
              : t('upNext.sendStatus.tryAgain', 'Try again')}
          </Button>
        )}
      </p>
      {refusal && (
        <p role="alert" className="min-w-0 break-words text-destructive">
          {refusal}
        </p>
      )}
    </div>
  )
}
