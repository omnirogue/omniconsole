import { useRef, useState } from 'react'
import { ExternalLink, FileText, RotateCcw, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription
} from '@/components/ui/sheet'
import {
  conversationFleetSummary,
  hasUnconfirmedFleetCancellation
} from '@/lib/conversation-fleet-summary'
import { WorkflowJobResults } from '@/components/console-workflows/WorkflowJobResults'
import { WorkflowDetail } from '@/components/console-workflows/WorkflowDetail'
import { getIntlLocale, translate } from '@/i18n/i18n'
import {
  conversationFleetProgress,
  fleetRunPersonActions,
  type ConversationFleetPhase
} from '@/lib/conversation-fleet-progress'
import { workflowWebLink } from '@/lib/console-workflow-client'
import { openWorkDecisions } from '@/lib/open-work-decisions'
import {
  conversationFleetScope,
  useConversationFleetStore,
  type ConversationFleetView
} from '@/store/conversation-fleet-store'
import {
  canCancelFleetRun,
  canRetryFleetRun,
  FleetDispatchCancelDialog,
  useFleetStageRetry
} from './FleetDispatchControls'

export function fleetProgressLabel(phase: ConversationFleetPhase): string {
  switch (phase) {
    case 'working':
      return translate('conversationFleet.working', 'Working')
    case 'waiting':
      return translate('conversationFleet.waiting', 'Waiting')
    case 'needs-you':
      return translate('conversationFleet.needsYou', 'Needs you')
    case 'failed':
      return translate('conversationFleet.failed', 'Couldn’t finish')
    case 'complete':
      return translate('conversationFleet.complete', 'Done')
    case 'cancelled':
      return translate('conversationFleet.phaseCancelled', 'Cancelled')
    case 'unverifiable':
      return translate('conversationFleet.unverifiable', 'Status unavailable')
  }
}

export function fleetRunLabel(run: ConversationFleetView): string {
  if (hasUnconfirmedFleetCancellation(run)) {
    return translate('conversationFleet.stopUnconfirmed', 'Waiting for stop confirmation')
  }
  const progress = conversationFleetProgress(run.jobs, run.verified)
  const actions = fleetRunPersonActions(run.jobs)
  if (run.admission !== 'pending' && progress.phase === 'needs-you' && !actions.decisions.length) {
    return translate('conversationFleet.reviewReady', 'Review ready')
  }
  return run.admission === 'pending'
    ? translate('conversationFleet.admissionUnverified', 'Checking whether it started')
    : fleetProgressLabel(progress.phase)
}

/** Kept outside menu triggers so closing a menu doesn't unmount the summary. */
export function FleetDispatchDetailsDialog({
  run,
  open,
  onOpenChange,
  onCloseAutoFocus
}: {
  run: ConversationFleetView
  open: boolean
  onOpenChange: (open: boolean) => void
  onCloseAutoFocus?: (event: Event) => void
}) {
  const progress = conversationFleetProgress(run.jobs, run.verified)
  const scope = conversationFleetScope()
  const [cancelOpen, setCancelOpen] = useState(false)
  const [technicalOpen, setTechnicalOpen] = useState(false)
  const titleRef = useRef<HTMLHeadingElement>(null)
  const summary = conversationFleetSummary(run)
  const resultJobs = run.jobs.filter((job) =>
    job.execution_artifacts?.some(
      (receipt) => receipt.job_id === job.id && receipt.attempt === job.attempt
    )
  )
  const stageRetry = useFleetStageRetry(run)
  const cancellable = canCancelFleetRun(run)
  const retryable = canRetryFleetRun(run)
  const actions = fleetRunPersonActions(run.jobs)
  const actionsVerified = run.admission === 'accepted' && run.verified
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setTechnicalOpen(false)
        }
        onOpenChange(next)
      }}
      modal={false}
    >
      <SheetContent
        className="scrollbar-sleek w-full overflow-y-auto p-5 sm:max-w-xl"
        onKeyDown={(event) => event.stopPropagation()}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          titleRef.current?.focus()
        }}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <SheetHeader className="px-0 pb-4 pt-0 pr-8">
          <SheetTitle ref={titleRef} tabIndex={-1} className="break-words text-base outline-none">
            {run.title}
          </SheetTitle>
          <SheetDescription>{summary.text}</SheetDescription>
        </SheetHeader>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <p className="text-sm">{fleetRunLabel(run)}</p>
          <p className="text-xs text-muted-foreground">
            {progress.machines.join(', ') ||
              run.machine ||
              translate('conversationFleet.queuedMachine', 'Waiting for a fleet machine')}
          </p>
        </div>
        {summary.lastActivityAt ? (
          <p className="pb-4 text-xs text-muted-foreground">
            {summary.lastActivitySource === 'job'
              ? translate('conversationFleet.updatedAt', 'Updated {{date}}', {
                  date: new Date(summary.lastActivityAt).toLocaleString(getIntlLocale())
                })
              : translate('conversationFleet.recordedAt', 'Recorded {{date}}', {
                  date: new Date(summary.lastActivityAt).toLocaleString(getIntlLocale())
                })}
          </p>
        ) : null}
        {resultJobs.map((job) => (
          <section key={job.id} aria-label={job.title} className="mb-3 space-y-2">
            <h3 className="text-sm font-medium">{job.title}</h3>
            <WorkflowJobResults job={job} />
          </section>
        ))}
        {cancellable || retryable ? (
          <div className="flex flex-wrap gap-2">
            {cancellable ? (
              <Button variant="outline" size="sm" onClick={() => setCancelOpen(true)}>
                <XCircle className="size-3.5" />
                {translate('conversationFleet.stopWork', 'Stop work')}
              </Button>
            ) : null}
            {retryable ? (
              <Button
                variant="outline"
                size="sm"
                disabled={stageRetry.retrying}
                onClick={() => void stageRetry.retry()}
              >
                <RotateCcw className="size-3.5" />
                {translate('conversationFleet.retryStopped', 'Try again')}
              </Button>
            ) : null}
          </div>
        ) : null}
        <FleetDispatchCancelDialog run={run} open={cancelOpen} onOpenChange={setCancelOpen} />
        {actionsVerified && actions.reviewUrls.length > 0 ? (
          <div className="flex flex-wrap gap-2" data-fleet-reviews="">
            {actions.reviewUrls.map((url) => {
              const href = workflowWebLink(url)
              return href ? (
                <Button key={url} variant="outline" size="sm" asChild>
                  <a href={href} target="_blank" rel="noreferrer">
                    <ExternalLink className="size-3.5" />
                    {translate('consoleWorkflows.openReview', 'Open review')}
                  </a>
                </Button>
              ) : null
            })}
          </div>
        ) : null}
        {actionsVerified && actions.decisions.length > 0 ? (
          <Button variant="outline" size="sm" onClick={() => openWorkDecisions()}>
            {translate('conversationFleet.openDecisionsView', 'Open Decisions')}
          </Button>
        ) : null}
        {run.admission === 'pending' && !run.intent && run.error ? (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              {translate(
                'conversationFleet.dismissUnconfirmedHelp',
                'Dismissing this entry does not cancel work that may have started. A confirmed workflow can appear here again.'
              )}
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                useConversationFleetStore.getState().dismissUnconfirmed(scope, run.workflowId)
                onOpenChange(false)
              }}
            >
              {translate('conversationFleet.dismissUnconfirmed', 'Dismiss unconfirmed')}
            </Button>
          </div>
        ) : null}
        <details
          open={technicalOpen}
          className="mt-4 border-t pt-3"
          onToggle={(event) => setTechnicalOpen(event.currentTarget.open)}
        >
          <summary className="cursor-pointer text-xs text-muted-foreground">
            {translate('conversationFleet.technicalDetails', 'Technical details')}
          </summary>
          {technicalOpen ? (
            <div className="mt-3 space-y-3">
              {run.error ? (
                <p className="break-words text-xs text-muted-foreground">{run.error}</p>
              ) : null}
              <WorkflowDetail
                workflowId={run.workflowId}
                onJobs={(jobs) =>
                  useConversationFleetStore.getState().recordJobs(scope, run.workflowId, jobs, null)
                }
              />
            </div>
          ) : null}
        </details>
      </SheetContent>
    </Sheet>
  )
}

export function FleetDispatchDetails({
  run,
  compact = false
}: {
  run: ConversationFleetView
  compact?: boolean
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button
        variant="ghost"
        size="xs"
        onClick={() => setOpen(true)}
        data-fleet-workflow={run.workflowId}
      >
        <FileText className="size-3.5" />
        {compact && run.admission !== 'pending'
          ? translate('conversationFleet.details', 'View summary')
          : fleetRunLabel(run)}
      </Button>
      <FleetDispatchDetailsDialog run={run} open={open} onOpenChange={setOpen} />
    </>
  )
}
