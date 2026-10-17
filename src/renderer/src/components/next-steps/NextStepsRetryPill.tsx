import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { ConversationSource } from '../../../../shared/conversation-source'
import { generateNextStepSet } from './next-steps-client'
import { refreshPendingNextSteps } from './next-steps-pending-store'
import { resolveNextStepsTrayView } from './next-steps-tray-model'
import { useNextStepsCurrent } from './use-next-steps-current'

/** How much of the suggester's error the pill's tooltip shows. */
export const NEXT_STEPS_RETRY_REASON_MAX = 160

function shortened(reason: string): string {
  const text =
    reason.trim() || translate('nextSteps.failedNoReason', 'Suggestions could not be generated.')
  return text.length > NEXT_STEPS_RETRY_REASON_MAX
    ? `${text.slice(0, NEXT_STEPS_RETRY_REASON_MAX - 1).trimEnd()}…`
    : text
}

/**
 * The current turn's suggestions failed: a quiet pill in the terminal's corner says so, and its
 * Retry is the tray's explicit "Suggest again". Nothing retries by itself. Shows `fallback` (the
 * suggested-starts pill) otherwise. `active` only while the agent sits on a finished turn, so an
 * idle pane is asked about its turn and a working one is not.
 */
export function NextStepsRetryPill({
  conversation,
  active,
  fallback
}: {
  conversation: ConversationSource
  active: boolean
  fallback: React.ReactNode
}) {
  const { current, upsert, refresh } = useNextStepsCurrent(conversation, active)
  const view = resolveNextStepsTrayView(active ? current : null, undefined)
  const [retrying, setRetrying] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  // Why a ref: two clicks in one frame both see the state from before the first one.
  const inFlight = useRef(false)
  if (view.failure === null || view.shown || view.thinking || view.answered) {
    return <>{fallback}</>
  }
  const reason = shortened(view.failure)
  const retry = (): void => {
    if (inFlight.current) {
      return
    }
    inFlight.current = true
    setRetrying(true)
    setProblem(null)
    generateNextStepSet(conversation, true)
      .then((result) => {
        if (result.set) {
          upsert(result.set)
        } else {
          setProblem(result.skipped)
        }
      })
      .catch((failure: unknown) =>
        setProblem(failure instanceof Error ? failure.message : String(failure))
      )
      .finally(() => {
        inFlight.current = false
        setRetrying(false)
        refresh()
        refreshPendingNextSteps()
      })
  }
  return (
    <div
      className="pointer-events-none absolute top-11 right-3 z-10 flex max-w-[70%] flex-col items-end gap-1"
      data-next-steps-retry={conversation.paneKey}
    >
      <Button
        size="xs"
        variant="ghost"
        className="pointer-events-auto max-w-full rounded-full border border-border bg-background text-muted-foreground shadow-xs"
        disabled={retrying}
        title={reason}
        aria-label={translate('nextSteps.retryLabel', 'Retry suggesting next steps: {{reason}}', {
          reason
        })}
        onClick={retry}
      >
        <span className="truncate">
          {translate('nextSteps.retryPill', 'Couldn’t suggest next steps · Retry')}
        </span>
      </Button>
      {problem ? (
        <p
          role="alert"
          className="pointer-events-auto max-w-full truncate rounded-sm bg-background px-2 py-0.5 text-xs text-muted-foreground"
          title={problem}
        >
          {problem}
        </p>
      ) : null}
    </div>
  )
}
