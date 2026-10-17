import { useState, type ReactNode } from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { WorkflowProviderIcon as AgentIcon } from '@/lib/workflow-provider-icon'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { WorkflowMarkdown } from './WorkflowMarkdown'
import type {
  LocalWorkflowCouncilRun,
  LocalWorkflowView
} from '../../../../shared/local-workflow-view'
import { deanonymizeCouncilText, workflowCall } from './council-run-text'
import { CouncilRankings } from './CouncilRankings'
import { callStateLabel } from './local-workflow-labels'
import { WorkflowCallBody, WorkflowCallDot, type WorkflowCallHandlers } from './WorkflowCallBody'
import { WorkflowStageItem, WorkflowStageRail } from './WorkflowStageRail'
import { useStageDisclosure } from './use-stage-disclosure'
import { workflowStages, type WorkflowStageModel } from './workflow-run-stages'

/** Stage 1: one tab per member with its live tail, then its answer. */
function CouncilAnswers({
  view,
  run,
  handlers
}: {
  view: LocalWorkflowView
  run: LocalWorkflowCouncilRun
  handlers: WorkflowCallHandlers
}) {
  const [selected, setSelected] = useState<string>()
  const value = run.members.some((member) => member.seatId === selected)
    ? selected
    : run.members[0]?.seatId
  if (!value) {
    return null
  }
  return (
    <div className="rounded-xl border bg-card">
      <Tabs value={value} onValueChange={setSelected} className="gap-0">
        <TabsList
          variant="line"
          aria-label={translate('localWorkflow.councilRun.answers', 'Answers by model')}
          className="h-auto w-full justify-start gap-0 overflow-x-auto rounded-none border-b px-2 scrollbar-sleek"
        >
          {run.members.map((member) => {
            const call = workflowCall(view, member.answerCallId)
            return (
              <TabsTrigger
                key={member.seatId}
                value={member.seatId}
                className="h-9 flex-none gap-1.5 px-3 text-xs"
              >
                <AgentIcon agent={member.agent} size={13} />
                {member.modelLabel}
                <WorkflowCallDot call={call} />
                <span className="sr-only">{call ? callStateLabel(call) : ''}</span>
              </TabsTrigger>
            )
          })}
        </TabsList>
        {run.members.map((member) => (
          <TabsContent key={member.seatId} value={member.seatId} className="p-4">
            <WorkflowCallBody
              call={workflowCall(view, member.answerCallId)}
              subject={member.modelLabel}
              {...handlers}
            />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  )
}

/** Stage 3: the chairman's card, highlighted once the answer is accepted. */
function ChairmanAnswer({
  view,
  run,
  stage,
  handlers,
  resultFooter
}: {
  view: LocalWorkflowView
  run: LocalWorkflowCouncilRun
  stage: WorkflowStageModel
  handlers: WorkflowCallHandlers
  resultFooter?: ReactNode
}) {
  const call = stage.calls.at(-1)
  const chair = run.chair
  const name =
    chair?.modelLabel ?? translate('localWorkflow.councilRun.theChairman', 'The chairman')
  // Why: the chairman quotes the reviewers' anonymous labels; readers see the model names, also
  // in the moment between the chair call finishing and the run's result landing.
  const markdown =
    view.result?.markdown ?? (call?.state === 'completed' ? call.resultMarkdown : undefined)
  const answer = markdown ? (
    <WorkflowMarkdown
      className="text-[15px] leading-7"
      content={deanonymizeCouncilText(markdown, run.members)}
    />
  ) : undefined
  return (
    <section
      aria-label={translate('localWorkflow.councilRun.chairmanAnswer', "Chairman's answer")}
      className={cn(
        'space-y-3 rounded-xl border bg-card p-4',
        view.state === 'completed' && view.result && 'border-status-success-border'
      )}
    >
      <header className="flex items-center gap-2 text-sm">
        {chair ? <AgentIcon agent={chair.agent} size={14} /> : null}
        <span className="font-medium">
          {chair
            ? translate('localWorkflow.councilRun.chairmanNamed', 'Chairman · {{model}}', {
                model: chair.modelLabel
              })
            : translate('localWorkflow.councilRun.chairman', 'Chairman')}
        </span>
      </header>
      {call ? (
        <WorkflowCallBody call={call} subject={name} {...handlers}>
          {answer}
        </WorkflowCallBody>
      ) : (
        answer
      )}
      {view.result ? resultFooter : null}
    </section>
  )
}

/** Karpathy's llm-council layout on a live stage rail. */
export function CouncilRunView({
  view,
  run,
  handlers,
  resultFooter
}: {
  view: LocalWorkflowView
  run: LocalWorkflowCouncilRun
  handlers: WorkflowCallHandlers
  resultFooter?: ReactNode
}) {
  const stages = workflowStages(view)
  const disclosure = useStageDisclosure(view, stages)
  const [answers, rankings, chair] = stages
  return (
    <WorkflowStageRail label={translate('localWorkflow.councilRun.stages', 'Council stages')}>
      {answers && (
        <WorkflowStageItem stage={answers} {...disclosure.props(answers)}>
          <CouncilAnswers view={view} run={run} handlers={handlers} />
        </WorkflowStageItem>
      )}
      {rankings && (
        <WorkflowStageItem stage={rankings} {...disclosure.props(rankings)}>
          {rankings.tone !== 'queued' || run.ballots.length ? (
            <CouncilRankings
              view={view}
              run={run}
              stageCalls={rankings.calls}
              handlers={handlers}
            />
          ) : null}
        </WorkflowStageItem>
      )}
      {chair && (
        <WorkflowStageItem stage={chair} {...disclosure.props(chair)}>
          {chair.tone !== 'queued' || view.result ? (
            <ChairmanAnswer
              view={view}
              run={run}
              stage={chair}
              handlers={handlers}
              resultFooter={resultFooter}
            />
          ) : null}
        </WorkflowStageItem>
      )}
    </WorkflowStageRail>
  )
}
