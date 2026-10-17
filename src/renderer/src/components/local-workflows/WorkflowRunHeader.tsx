import { Flag, Pause, Play, RotateCcw, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useNow } from '@/hooks/use-now'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type {
  LocalWorkflowAction,
  LocalWorkflowRunState,
  LocalWorkflowView
} from '../../../../shared/local-workflow-view'
import { WorkflowPresetIcon } from './workflow-presets'
import { WorkflowRunPlacement } from './WorkflowRunPlacement'
import { formatWorkflowElapsed, formatWorkflowTokens, runStateLabel } from './local-workflow-labels'

const TERMINAL: readonly LocalWorkflowRunState[] = [
  'completed',
  'cancelled',
  'failed',
  'recovery_required'
]

const STATE_DOT: Record<LocalWorkflowRunState, string> = {
  running: 'bg-status-info motion-safe:animate-pulse',
  stopping: 'bg-status-info',
  pausing: 'bg-status-warning motion-safe:animate-pulse',
  paused: 'bg-status-warning',
  budget_paused: 'bg-status-warning',
  recovery_required: 'bg-status-warning',
  completed: 'bg-status-success',
  failed: 'bg-destructive',
  cancelled: 'bg-muted-foreground/60'
}

function actionLabel(action: LocalWorkflowAction): string {
  switch (action) {
    case 'pause':
      return translate('localWorkflow.pause', 'Pause')
    case 'resume':
      return translate('localWorkflow.resume', 'Resume')
    case 'stop':
      return translate('localWorkflow.stop', 'Stop')
    case 'retry':
      return translate('localWorkflow.run.retry', 'Retry')
    case 'finish':
      return translate('localWorkflow.run.finishNow', 'Finish now')
  }
}

function ActionIcon({ action }: { action: LocalWorkflowAction }) {
  switch (action) {
    case 'pause':
      return <Pause aria-hidden="true" className="size-3.5" />
    case 'resume':
      return <Play aria-hidden="true" className="size-3.5" />
    case 'stop':
      return <Square aria-hidden="true" className="size-3" />
    case 'retry':
      return <RotateCcw aria-hidden="true" className="size-3.5" />
    case 'finish':
      return <Flag aria-hidden="true" className="size-3.5" />
  }
}

/** Leaf so the shared one-second clock re-renders only the digits. */
function RunElapsed({ view }: { view: LocalWorkflowView }) {
  const settled = TERMINAL.includes(view.state)
  const now = useNow(1_000, !settled && view.finishedAt === undefined)
  if (settled && view.finishedAt === undefined) {
    return null
  }
  return (
    <span className="tabular-nums" aria-hidden={!settled || undefined}>
      {formatWorkflowElapsed((view.finishedAt ?? now) - view.startedAt)}
    </span>
  )
}

/**
 * One quiet line: preset, state, elapsed, progress and the controls the host offers, with where
 * it runs and who asked beneath. The program's own log lines live in the run's Notes, not here.
 */
export function WorkflowRunHeader({
  view,
  pending,
  onAction
}: {
  view: LocalWorkflowView
  pending: boolean
  onAction?: (action: LocalWorkflowAction) => void
}) {
  const connected = view.connection === 'connected'
  const done = view.calls.filter((call) => call.state === 'completed').length
  const tokens = view.usage?.tokens
  const settled = TERMINAL.includes(view.state)
  const progress = settled
    ? translate('localWorkflow.run.agentsFinished', '{{count}} agents', {
        count: view.calls.length
      })
    : translate('localWorkflow.run.progress', '{{running}} working · {{done}} done', {
        running: view.running,
        done
      })
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b pb-3">
      <div
        role="status"
        aria-live="polite"
        className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-sm"
      >
        <WorkflowPresetIcon
          preset={
            view.audit
              ? 'audit'
              : view.graphRun?.spec.template === 'custom'
                ? 'custom'
                : view.preset
          }
          className="size-4 text-muted-foreground"
        />
        <span
          aria-hidden="true"
          className={cn('size-2 shrink-0 rounded-full', STATE_DOT[view.state])}
        />
        <span className="font-medium">{runStateLabel(view.state)}</span>
        <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          <RunElapsed view={view} />
          <span>
            {connected
              ? progress
              : translate('localWorkflow.run.connectionLost', 'Connection lost · status unknown')}
          </span>
          {view.queued > 0 && connected && !settled ? (
            <span>
              {translate('localWorkflow.run.waitingCount', '{{count}} waiting', {
                count: view.queued
              })}
            </span>
          ) : null}
          {view.finishing && connected ? (
            <span>
              {translate(
                'localWorkflow.run.finishing',
                'Finishing · no new agents, the report uses what is in'
              )}
            </span>
          ) : null}
          {tokens ? (
            <span className="font-mono text-[11px]">
              {translate('localWorkflow.run.tokens', '{{amount}} tokens', {
                amount: formatWorkflowTokens(tokens.input + tokens.output)
              })}
            </span>
          ) : null}
        </span>
      </div>
      {onAction && (view.actions.length > 0 || view.canFinish) && (
        <div className="flex items-center gap-1">
          {[...(view.canFinish ? (['finish'] as const) : []), ...view.actions].map((action) => (
            <Button
              key={action}
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 gap-1.5 px-2 text-xs"
              disabled={pending || !connected}
              onClick={() => onAction(action)}
            >
              <ActionIcon action={action} />
              {actionLabel(action)}
            </Button>
          ))}
        </div>
      )}
      <WorkflowRunPlacement view={view} />
    </div>
  )
}
