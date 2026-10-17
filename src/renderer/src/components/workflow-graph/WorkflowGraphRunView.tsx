import { useState, type ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { LocalWorkflowView } from '../../../../shared/local-workflow-view'
import { workflowFinalStep } from '../../../../shared/workflow-graph-topology'
import type { WorkflowCallHandlers } from '../local-workflows/WorkflowCallBody'
import { WorkflowFinalCard } from '../local-workflows/WorkflowResult'
import { WorkflowGraphCanvas, type WorkflowStepStatus } from './WorkflowGraphCanvas'
import { WorkflowFindProgress } from './WorkflowFindProgress'
import { WorkflowImproveTrail } from './WorkflowImproveTrail'
import { WorkflowStepDetail } from './WorkflowStepDetail'
import { WorkflowWebSources } from './WorkflowWebSources'

/**
 * A workflow graph run: the graph it froze at Start, every step's state as the host derives it
 * from the durable call records, the selected step's agents at work, the gaps, and the result.
 */
export function WorkflowGraphRunView({
  view,
  handlers,
  resultFooter,
  onOpenLocation
}: {
  view: LocalWorkflowView
  handlers: WorkflowCallHandlers
  resultFooter?: ReactNode
  onOpenLocation?: (location: string) => void
}) {
  const run = view.graphRun!
  const final = workflowFinalStep(run.spec)
  const [picked, setPicked] = useState<string>()
  const status: Record<string, WorkflowStepStatus> = Object.fromEntries(
    run.steps.map((step) => {
      const calls = step.rounds.flatMap((round) => round.calls)
      return [
        step.id,
        {
          state: step.state,
          done: calls.filter((call) => call.status !== 'waiting').length,
          total: calls.length,
          ...(step.rounds.length > 1 ? { round: step.rounds.at(-1)!.round } : {})
        }
      ]
    })
  )
  // Follow the work: the step running now, else the last one that ran, unless one was picked.
  const running = run.steps.findLast((step) => step.state === 'running')?.id
  const lastRan = run.steps.findLast(
    (step) => step.state !== 'waiting' && step.state !== 'not-run'
  )?.id
  const selectedId = picked ?? running ?? lastRan ?? run.steps[0]?.id
  const selected = run.steps.find((step) => step.id === selectedId)
  const settled = ['completed', 'failed', 'cancelled'].includes(view.state)
  return (
    <div className="space-y-4">
      <WorkflowGraphCanvas
        spec={run.spec}
        status={status}
        selectedId={selectedId}
        onSelect={setPicked}
      />
      {run.loop?.improve ? (
        <WorkflowImproveTrail loop={run.loop} seats={run.steps.flatMap((step) => step.agents)} />
      ) : null}
      {run.find ? <WorkflowFindProgress trail={run.find} running={!settled} /> : null}
      {run.web?.sources.length ? <WorkflowWebSources trail={run.web} /> : null}
      {settled && run.gaps.length > 0 && (
        <section
          aria-label={translate('workflowGraph.run.gaps', 'What did not go to plan')}
          className="space-y-1 rounded-lg border border-status-warning-border bg-status-warning/5 p-3 text-xs"
        >
          <p className="flex items-center gap-1.5 font-medium">
            <AlertTriangle aria-hidden="true" className="size-3.5 text-status-warning" />
            {view.state === 'completed'
              ? translate('workflowGraph.run.completedWithGaps', 'Finished with gaps')
              : translate('workflowGraph.run.gapsBeforeFailure', 'Before it stopped')}
          </p>
          <ul className="list-disc space-y-0.5 pl-5">
            {run.gaps.map((gap) => (
              <li key={gap}>{gap}</li>
            ))}
          </ul>
        </section>
      )}
      {/* The final step's answer is the result card below, unless someone asked to see its agents. */}
      {selected && (picked === selected.id || selected.id !== final?.id || !view.result) ? (
        <WorkflowStepDetail
          view={view}
          step={selected}
          handlers={handlers}
          onOpenLocation={onOpenLocation}
        />
      ) : null}
      {view.result && (
        <WorkflowFinalCard
          title={
            run.spec.find
              ? translate('workflowGraph.find.result', 'Best options')
              : (final?.title ?? translate('workflowGraph.run.result', 'Result'))
          }
          markdown={view.result.markdown}
          appendix={view.result.appendix}
          highlighted={view.state === 'completed'}
          footer={resultFooter}
        />
      )}
    </div>
  )
}
