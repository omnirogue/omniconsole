import { useState, type ReactNode } from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { WorkflowProviderIcon as AgentIcon } from '@/lib/workflow-provider-icon'
import { translate } from '@/i18n/i18n'
import type { LocalWorkflowView } from '../../../../shared/local-workflow-view'
import { CouncilLegacyReviews } from './CouncilLegacyReviews'
import { callStateLabel } from './local-workflow-labels'
import { LocalWorkflowEvidence } from './LocalWorkflowEvidence'
import { WorkflowAgentList } from './WorkflowAgentList'
import { WorkflowCallBody, WorkflowCallDot, type WorkflowCallHandlers } from './WorkflowCallBody'
import { WorkflowFinalCard } from './WorkflowResult'
import { WorkflowStageItem, WorkflowStageRail } from './WorkflowStageRail'
import { useStageDisclosure } from './use-stage-disclosure'
import { workflowStages, type WorkflowStageModel } from './workflow-run-stages'

function StageCalls({
  stage,
  handlers
}: {
  stage: WorkflowStageModel
  handlers: WorkflowCallHandlers
}) {
  const [selected, setSelected] = useState<string>()
  const value = stage.calls.some((call) => call.id === selected) ? selected : stage.calls[0]?.id
  if (!value) {
    return null
  }
  return (
    <div className="rounded-xl border bg-card">
      <Tabs value={value} onValueChange={setSelected} className="gap-0">
        <TabsList
          variant="line"
          aria-label={stage.label}
          className="h-auto w-full justify-start gap-0 overflow-x-auto rounded-none border-b px-2 scrollbar-sleek"
        >
          {stage.calls.map((call) => (
            <TabsTrigger
              key={call.id}
              value={call.id}
              className="h-9 flex-none gap-1.5 px-3 text-xs"
            >
              {call.agent ? <AgentIcon agent={call.agent} size={13} /> : null}
              {call.modelLabel ?? call.seatLabel}
              <WorkflowCallDot call={call} />
              <span className="sr-only">{callStateLabel(call)}</span>
            </TabsTrigger>
          ))}
        </TabsList>
        {stage.calls.map((call) => (
          <TabsContent key={call.id} value={call.id} className="p-4">
            <WorkflowCallBody
              call={call}
              subject={call.modelLabel ?? call.seatLabel}
              {...handlers}
            />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  )
}

function stageBody(
  stage: WorkflowStageModel,
  handlers: WorkflowCallHandlers,
  legacyCouncil?: NonNullable<LocalWorkflowView['council']>
): ReactNode {
  if (legacyCouncil) {
    // Ballots are structured data; read them as reviews, with each call's logs a click away.
    return (
      <div className="space-y-3">
        <CouncilLegacyReviews council={legacyCouncil} />
        <WorkflowAgentList calls={stage.calls} handlers={handlers} />
      </div>
    )
  }
  return stage.calls.length ? <StageCalls stage={stage} handlers={handlers} /> : null
}

/**
 * Runs whose host publishes no preset-specific view (older revisions) still get the same rail,
 * per-agent tabs and final card, so the page never blanks.
 */
export function WorkflowGenericRun({
  view,
  handlers,
  resultFooter
}: {
  view: LocalWorkflowView
  handlers: WorkflowCallHandlers
  resultFooter?: ReactNode
}) {
  const stages = workflowStages(view)
  const disclosure = useStageDisclosure(view, stages)
  const final = view.result ? (
    <WorkflowFinalCard
      title={
        view.preset === 'council'
          ? translate('localWorkflow.councilRun.chairmanAnswer', "Chairman's answer")
          : translate('localWorkflow.discoverRun.report', 'Report')
      }
      markdown={view.result.markdown}
      highlighted={view.state === 'completed'}
      footer={resultFooter}
    />
  ) : null
  const lastIndex = stages.length - 1
  const legacyCouncil =
    view.preset === 'council' && (view.council?.reviews.length || view.council?.ranking.length)
      ? view.council
      : undefined
  return (
    <div className="space-y-4">
      {stages.length > 0 && (
        <WorkflowStageRail label={translate('localWorkflow.run.stages', 'Stages')}>
          {stages.map((stage) => (
            <WorkflowStageItem key={stage.id} stage={stage} {...disclosure.props(stage)}>
              {stage.index === lastIndex && final
                ? final
                : stageBody(stage, handlers, stage.index === 1 ? legacyCouncil : undefined)}
            </WorkflowStageItem>
          ))}
        </WorkflowStageRail>
      )}
      {stages.length === 0 ? final : null}
      {view.preset === 'discover' && (view.findings?.length || view.discoverCounts) ? (
        <LocalWorkflowEvidence view={view} />
      ) : null}
    </div>
  )
}
