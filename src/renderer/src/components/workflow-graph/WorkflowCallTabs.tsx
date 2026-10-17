import { useState } from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { WorkflowProviderIcon as AgentIcon } from '@/lib/workflow-provider-icon'
import { ModelDot } from '@/components/ModelDot'
import { translate } from '@/i18n/i18n'
import type {
  LocalWorkflowCallView,
  LocalWorkflowGraphRound,
  LocalWorkflowGraphRun
} from '../../../../shared/local-workflow-view'
import {
  WorkflowCallBody,
  WorkflowCallDot,
  type WorkflowCallHandlers
} from '../local-workflows/WorkflowCallBody'
import { workflowVerdictLabel } from './workflow-graph-labels'

type Step = LocalWorkflowGraphRun['steps'][number]
/** Every agent call of one round as tabs: agent, model, live state; the body is the call itself. */
export function WorkflowCallTabs({
  step,
  round,
  calls,
  handlers,
  filter
}: {
  step: Step
  round: LocalWorkflowGraphRound
  calls: ReadonlyMap<string, LocalWorkflowCallView>
  handlers: WorkflowCallHandlers
  filter?: (callId: string) => boolean
}) {
  const entries = round.calls.filter((call) => !filter || filter(call.callId))
  const [selected, setSelected] = useState<string>()
  const value = entries.some((entry) => entry.callId === selected) ? selected : entries[0]?.callId
  if (!value) {
    return null
  }
  return (
    <Tabs value={value} onValueChange={setSelected} className="gap-0 rounded-lg border">
      <TabsList
        variant="line"
        className="h-auto w-full justify-start gap-0 overflow-x-auto rounded-none border-b px-2 scrollbar-sleek"
      >
        {entries.map((entry) => {
          const agent = step.agents[entry.agentIndex]
          const label = round.labels?.find((item) => item.callId === entry.callId)?.label
          return (
            <TabsTrigger
              key={entry.callId}
              value={entry.callId}
              className="h-9 flex-none gap-1.5 px-3 text-xs"
            >
              {entry.jev ? (
                <ModelDot agent="jev" />
              ) : (
                <>
                  <ModelDot agent={agent?.agent} model={agent?.model} />
                  <AgentIcon agent={agent?.agent} size={13} />
                </>
              )}
              {entry.jev
                ? translate('workflowGraph.detail.jev', 'JEV')
                : (agent?.modelLabel ?? entry.callId)}
              {label && !entry.itemKey && !entry.jev ? ` · ${label}` : ''}
              {entry.verdict ? ` · ${workflowVerdictLabel(entry.verdict)}` : ''}
              <WorkflowCallDot call={calls.get(entry.callId)} />
            </TabsTrigger>
          )
        })}
      </TabsList>
      {entries.map((entry) => (
        <TabsContent key={entry.callId} value={entry.callId} className="p-3">
          {step.agents[entry.agentIndex]?.angle && (
            <p className="mb-2 text-xs text-muted-foreground">
              {translate('workflowGraph.detail.angle', 'Angle: {{angle}}', {
                angle: step.agents[entry.agentIndex]!.angle!
              })}
            </p>
          )}
          <WorkflowCallBody
            call={calls.get(entry.callId)}
            subject={
              entry.jev
                ? translate('workflowGraph.detail.jev', 'JEV')
                : (step.agents[entry.agentIndex]?.modelLabel ?? entry.callId)
            }
            {...handlers}
          />
        </TabsContent>
      ))}
    </Tabs>
  )
}
