import { useEffect, useMemo, useState } from 'react'
import { ExternalLink, RefreshCw } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { WorkflowComposer } from '@/components/console-workflows/WorkflowComposer'
import { WorkflowDetail } from '@/components/console-workflows/WorkflowDetail'
import { WorkflowError } from '@/components/console-workflows/WorkflowFields'
import { WorkflowJobsList } from '@/components/console-workflows/WorkflowJobsList'
import {
  consoleWorkflowApi,
  workflowData,
  workflowErrorMessage,
  workflowWebLink,
  WorkflowRequestError
} from '@/lib/console-workflow-client'
import {
  describeWorkflowRun,
  workflowsOfJobs,
  type WorkflowRunSummary
} from '@/lib/console-workflow-run-summary'
import { translate } from '@/i18n/i18n'
import type { ConsoleJobRecord } from '../../../../../shared/console-workflow-task-types'
import type { ConsoleWorkflowJob } from '../../../../../shared/console-workflow-types'
import { invalidateBackofficeWork } from './backoffice-work-store'

type JobsRead =
  | { phase: 'loading' }
  | { phase: 'ready'; jobs: ConsoleJobRecord[] }
  | { phase: 'error'; message: string }
  /** An older server offers no stored-jobs read at all. */
  | { phase: 'not-served'; message: string }

function isUnserved(error: unknown): boolean {
  return error instanceof WorkflowRequestError && error.detail.code === 'capability_unavailable'
}

/** "Stage 2 of 5: Review · blocked on require_merged · on mw0003", or that the run is over. */
function RunSummaryLine({ summary }: { summary: WorkflowRunSummary }): React.JSX.Element {
  if (!summary.current) {
    return (
      <p className="text-xs text-muted-foreground" data-work-run-summary="finished">
        {translate('backofficeWork.runFinished', 'All {{count}} stages have finished.', {
          count: summary.total
        })}
      </p>
    )
  }
  const stage = summary.current
  const link = workflowWebLink(stage.prUrl)
  return (
    <p
      className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs"
      data-work-run-summary={stage.key}
    >
      <span>
        {translate('backofficeWork.runStage', 'Stage {{index}} of {{total}}: {{title}}', {
          index: stage.index,
          total: summary.total,
          title: stage.title
        })}
      </span>
      <Badge variant="outline" className="text-[10px]">
        {stage.state}
      </Badge>
      {stage.blockers.length > 0 ? (
        <span className="text-muted-foreground">
          {translate('backofficeWork.runBlockedOn', 'blocked on {{blockers}}', {
            blockers: stage.blockers.join(', ')
          })}
        </span>
      ) : null}
      {stage.machine ? (
        <span className="font-mono text-muted-foreground">
          {translate('backofficeWork.runOnMachine', 'on {{machine}}', { machine: stage.machine })}
        </span>
      ) : null}
      {link ? (
        <a
          className="inline-flex items-center gap-1 underline"
          href={link}
          target="_blank"
          rel="noreferrer"
        >
          <ExternalLink className="size-3" />
          {translate('backofficeWork.runPullRequest', 'Pull request')}
        </a>
      ) : null}
    </p>
  )
}

/**
 * The Run section of a card: which workflow runs on it (a card admitted twice has two, so a
 * picker, never an assumption), where that run stands, its graph, timeline and local controls.
 * Keyed by the caller on scope and card, so another account's or card's answer never lands here.
 */
export function BackofficeWorkRunSection({
  scope,
  taskId
}: {
  scope: string
  taskId: string
}): React.JSX.Element {
  const [read, setRead] = useState<JobsRead>({ phase: 'loading' })
  const [revision, setRevision] = useState(0)
  const [picked, setPicked] = useState<string | null>(null)
  const [graph, setGraph] = useState<{ workflowId: string; jobs: ConsoleWorkflowJob[] } | null>(
    null
  )
  const [composing, setComposing] = useState(false)
  const [showJobs, setShowJobs] = useState(false)
  useEffect(() => {
    let live = true
    setRead({ phase: 'loading' })
    void (async () => {
      try {
        const api = consoleWorkflowApi()
        if (!api.listJobs) {
          throw new WorkflowRequestError({
            code: 'capability_unavailable',
            message: translate(
              'backofficeWork.runJobsListUnavailable',
              'The server jobs list is unavailable in this version of OmniConsole.'
            )
          })
        }
        const listed = workflowData(await api.listJobs({ taskId })).jobs
        if (live) {
          // Why: only this card's jobs; a server answering more than asked never widens the section.
          setRead({ phase: 'ready', jobs: listed.filter((job) => job.task_id === taskId) })
        }
      } catch (error) {
        if (live) {
          const message = workflowErrorMessage(error)
          setRead(
            isUnserved(error) ? { phase: 'not-served', message } : { phase: 'error', message }
          )
        }
      }
    })()
    return () => {
      live = false
    }
  }, [taskId, revision])
  const workflows = useMemo(
    () => (read.phase === 'ready' ? workflowsOfJobs(read.jobs) : []),
    [read]
  )
  const workflowId =
    picked && workflows.some((workflow) => workflow.id === picked)
      ? picked
      : (workflows[0]?.id ?? null)
  const summary =
    workflowId && graph?.workflowId === workflowId ? describeWorkflowRun(graph.jobs) : null
  const refresh = (): void => setRevision((value) => value + 1)
  const admitted = (id: string): void => {
    setComposing(false)
    setPicked(id)
    invalidateBackofficeWork()
    refresh()
  }
  const composeButton = (
    <Button size="sm" variant="outline" onClick={() => setComposing(true)}>
      {translate('backofficeWork.runAsWorkflow', 'Run this as a workflow')}
    </Button>
  )
  return (
    <section className="space-y-3" data-work-run={taskId}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {translate('backofficeWork.runSection', 'Run')}
        </div>
        <Button
          variant="ghost"
          size="sm"
          disabled={read.phase === 'loading'}
          onClick={refresh}
          aria-label={translate('backofficeWork.runRefresh', 'Refresh run')}
        >
          <RefreshCw className="size-3.5" />
        </Button>
      </div>
      {read.phase === 'loading' ? (
        <p className="text-xs text-muted-foreground">
          {translate('backofficeWork.runLoading', 'Reading the card’s workflows…')}
        </p>
      ) : null}
      {read.phase === 'error' ? <WorkflowError message={read.message} /> : null}
      {read.phase === 'not-served' ? (
        <p className="text-xs text-muted-foreground" data-work-run-not-served="">
          {translate(
            'backofficeWork.runNotServed',
            'This server does not provide the card’s workflows, so nothing can be shown here.'
          )}
        </p>
      ) : null}
      {read.phase === 'ready' && workflows.length === 0 ? (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground" data-work-run-empty="">
            {translate('backofficeWork.runNone', 'No workflow is running on this card.')}
          </p>
          {composeButton}
        </div>
      ) : null}
      {workflows.length > 1 ? (
        <Select value={workflowId ?? undefined} onValueChange={setPicked}>
          <SelectTrigger
            size="sm"
            className="h-7 w-auto min-w-40 text-xs"
            aria-label={translate('backofficeWork.runPicker', 'Workflow')}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {workflows.map((workflow) => (
              <SelectItem key={workflow.id} value={workflow.id}>
                <span className="font-mono text-xs">{workflow.id}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
      {summary ? <RunSummaryLine summary={summary} /> : null}
      {workflowId ? (
        <>
          <WorkflowDetail
            key={`${scope}:${workflowId}`}
            workflowId={workflowId}
            onJobs={(jobs) => setGraph({ workflowId, jobs })}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="ghost" onClick={() => setShowJobs((value) => !value)}>
              {showJobs
                ? translate('backofficeWork.runHideJobs', 'Hide jobs and local execution')
                : translate('backofficeWork.runShowJobs', 'Jobs and local execution')}
            </Button>
            {composeButton}
          </div>
          {showJobs ? (
            <WorkflowJobsList key={`${scope}:${taskId}`} taskId={taskId} onOpen={setPicked} />
          ) : null}
        </>
      ) : null}
      <Dialog open={composing} onOpenChange={setComposing}>
        <DialogContent className="max-h-[85vh] overflow-y-auto scrollbar-sleek sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              {translate('backofficeWork.runAsWorkflow', 'Run this as a workflow')}
            </DialogTitle>
            <DialogDescription>
              {translate(
                'backofficeWork.runAsWorkflowHelp',
                'The stages are previewed and approved here before any job starts; the card and its revision are already bound.'
              )}
            </DialogDescription>
          </DialogHeader>
          {composing ? <WorkflowComposer initialTaskId={taskId} onAdmitted={admitted} /> : null}
        </DialogContent>
      </Dialog>
    </section>
  )
}
