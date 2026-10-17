import { fleetExecutionControlsAvailable } from '../../../../shared/fleet-execution-controls'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import { workflowErrorMessage } from '@/lib/console-workflow-client'
import { cancellableFleetJobs, retryableFleetJobs } from '@/lib/conversation-fleet-progress'
import {
  cancelConversationFleetRun,
  retryConversationFleetStages
} from '@/lib/conversation-fleet-controls'
import {
  conversationFleetScope,
  type ConversationFleetView
} from '@/store/conversation-fleet-store'
import type { ConsoleWorkflowCancellation } from '../../../../shared/console-workflow-control-types'

/** Only a run the server confirmed, with a stage still able to run, offers Cancel. */
export function canCancelFleetRun(run: ConversationFleetView): boolean {
  return (
    fleetExecutionControlsAvailable &&
    run.admission === 'accepted' &&
    run.verified &&
    cancellableFleetJobs(run.jobs).length > 0
  )
}

export function canRetryFleetRun(run: ConversationFleetView): boolean {
  return (
    fleetExecutionControlsAvailable &&
    run.admission === 'accepted' &&
    run.verified &&
    retryableFleetJobs(run.jobs).length > 0
  )
}

function announceCancellation(result: ConsoleWorkflowCancellation): void {
  if (result.refused.length > 0) {
    toast.warning(
      translate(
        'conversationFleet.cancelRefused',
        '{{count}} stages could not be cancelled: {{reason}}',
        { count: result.refused.length, reason: result.refused[0].message }
      )
    )
  } else if (result.cancel_requested.length > 0) {
    toast.success(
      translate(
        'conversationFleet.cancelRequested',
        'Fleet work cancelled. {{count}} running stages stop when their fleet machine next checks in.',
        { count: result.cancel_requested.length }
      )
    )
  } else if (result.cancelled.length > 0) {
    toast.success(translate('conversationFleet.cancelDone', 'Fleet work cancelled.'))
  } else {
    toast.info(translate('conversationFleet.nothingToCancel', 'Nothing was left to cancel.'))
  }
}

export function FleetDispatchCancelDialog({
  run,
  open,
  onOpenChange
}: {
  run: ConversationFleetView
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [cancelling, setCancelling] = useState(false)
  const confirm = async (): Promise<void> => {
    if (cancelling) {
      return
    }
    setCancelling(true)
    try {
      announceCancellation(
        await cancelConversationFleetRun(conversationFleetScope(), run.workflowId)
      )
      onOpenChange(false)
    } catch (error) {
      toast.error(workflowErrorMessage(error))
    } finally {
      setCancelling(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={(next) => !cancelling && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {translate('conversationFleet.cancelTitle', 'Cancel fleet work?')}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'conversationFleet.cancelHelp',
              '“{{title}}” has {{count}} unfinished stages. Queued stages stop now; running stages stop when their fleet machine next checks in. Finished stages are kept, and stopped stages can be retried.',
              { title: run.title, count: cancellableFleetJobs(run.jobs).length }
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" disabled={cancelling} onClick={() => onOpenChange(false)}>
            {translate('conversationFleet.keepRunning', 'Keep running')}
          </Button>
          <Button variant="destructive" disabled={cancelling} onClick={() => void confirm()}>
            {translate('conversationFleet.cancelConfirm', 'Cancel fleet work')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function useFleetStageRetry(run: ConversationFleetView): {
  retrying: boolean
  retry: () => Promise<void>
} {
  const [retrying, setRetrying] = useState(false)
  const retry = async (): Promise<void> => {
    if (retrying) {
      return
    }
    setRetrying(true)
    try {
      const outcome = await retryConversationFleetStages(conversationFleetScope(), run)
      if (outcome.failed.length > 0) {
        toast.error(
          translate(
            'conversationFleet.retryFailed',
            '{{count}} stages were not retried: {{reason}}',
            { count: outcome.failed.length, reason: outcome.failed[0].message }
          )
        )
      } else {
        toast.success(
          translate('conversationFleet.retried', '{{count}} stopped stages queued again.', {
            count: outcome.retried.length
          })
        )
      }
    } catch (error) {
      toast.error(workflowErrorMessage(error))
    } finally {
      setRetrying(false)
    }
  }
  return { retrying, retry }
}
