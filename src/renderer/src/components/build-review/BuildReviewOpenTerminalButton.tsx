import { useState } from 'react'
import { SquareTerminal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { openWorkerTerminal } from './open-worker-terminal'
import { withoutIdentifiers } from './build-review-plain-text'

const CLOSED_TERMINAL = /terminal_(?:handle_stale|gone|exited|not_found)|not found/i

/** An open-terminal failure in words: most often the terminal was closed since. */
function openTerminalError(error: unknown): { text: string; closed: boolean } {
  const text = error instanceof Error ? error.message : String(error)
  return CLOSED_TERMINAL.test(text)
    ? {
        text: translate('buildReview.worker.terminalClosed', 'That terminal is closed.'),
        closed: true
      }
    : { text: withoutIdentifiers(text), closed: false }
}

/**
 * Brings a worker's terminal forward, and says so in words when it cannot: a click that does
 * nothing reads as a broken button, and one found closed stays disabled. `live` names it for a
 * worker still running; `compact` is the quiet inline form a notice uses beside its sentence.
 */
export function BuildReviewOpenTerminalButton({
  handle,
  live = false,
  compact = false
}: {
  handle: string | null
  live?: boolean
  compact?: boolean
}) {
  const [error, setError] = useState<string | null>(null)
  const [closed, setClosed] = useState(false)
  const [pending, setPending] = useState(false)
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant={compact ? 'ghost' : 'outline'}
        className={cn(compact && 'h-6 px-2 text-xs')}
        disabled={!handle || pending || closed}
        onClick={async () => {
          if (!handle) {
            return
          }
          setPending(true)
          setError(null)
          try {
            await openWorkerTerminal(handle)
          } catch (error) {
            const failure = openTerminalError(error)
            setError(failure.text)
            setClosed(failure.closed)
          } finally {
            setPending(false)
          }
        }}
      >
        {live && <SquareTerminal aria-hidden="true" />}
        {live
          ? translate('buildReview.live.showTerminal', 'Show live terminal')
          : translate('auto.components.build-review.BuildReviewWorkerCard.open', 'Open terminal')}
      </Button>
      {error && (
        <p role="alert" className="w-full text-xs text-destructive">
          {error}
        </p>
      )}
    </>
  )
}
