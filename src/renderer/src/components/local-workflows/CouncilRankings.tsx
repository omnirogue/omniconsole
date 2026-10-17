import { useState } from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { WorkflowProviderIcon as AgentIcon } from '@/lib/workflow-provider-icon'
import { translate } from '@/i18n/i18n'
import { WorkflowMarkdown } from './WorkflowMarkdown'
import type {
  LocalWorkflowCallView,
  LocalWorkflowCouncilRun,
  LocalWorkflowView
} from '../../../../shared/local-workflow-view'
import {
  councilMemberByLabel,
  councilRankCall,
  councilReviewersRankedEveryAnswer,
  councilStandingRows,
  deanonymizeCouncilText
} from './council-run-text'
import { callStateLabel } from './local-workflow-labels'
import { WorkflowCallBody, WorkflowCallDot, type WorkflowCallHandlers } from './WorkflowCallBody'

function Ballot({
  run,
  seatId,
  call,
  subject,
  handlers
}: {
  run: LocalWorkflowCouncilRun
  seatId: string
  call?: LocalWorkflowCallView
  subject: string
  handlers: WorkflowCallHandlers
}) {
  const ballot = run.ballots.find((entry) => entry.reviewerSeatId === seatId)
  if (!ballot) {
    return <WorkflowCallBody call={call} subject={subject} {...handlers} />
  }
  return (
    <WorkflowCallBody call={call} subject={subject} {...handlers}>
      <div className="space-y-4">
        <WorkflowMarkdown
          className="text-sm"
          content={deanonymizeCouncilText(ballot.evaluation, run.members)}
        />
        <div className="space-y-1.5 rounded-lg bg-muted/40 p-3">
          <p className="text-xs font-medium text-muted-foreground">
            {translate('localWorkflow.councilRun.extractedRanking', 'Extracted ranking')}
          </p>
          {ballot.ranking.length ? (
            <ol className="list-decimal space-y-0.5 pl-5 text-sm">
              {ballot.ranking.map((label) => (
                <li key={label}>{councilMemberByLabel(run, label)?.modelLabel ?? label}</li>
              ))}
            </ol>
          ) : (
            <p className="text-sm text-muted-foreground">
              {translate(
                'localWorkflow.councilRun.noRanking',
                'No ranking could be read from this reply, so it does not count.'
              )}
            </p>
          )}
        </div>
      </div>
    </WorkflowCallBody>
  )
}

/** An answer no counted vote ranked: a dash, never an average that reads as first place. */
function NotRanked() {
  return (
    <>
      <span aria-hidden="true">—</span>
      <span className="sr-only">
        {translate('localWorkflow.councilRun.notRanked', 'Not ranked')}
      </span>
    </>
  )
}

function StreetCred({
  run,
  selfVotesDropped
}: {
  run: LocalWorkflowCouncilRun
  /** Only reviewers that saw their own answer cast a vote the aggregate has to drop. */
  selfVotesDropped: boolean
}) {
  const rows = councilStandingRows(run)
  if (!rows.length) {
    return null
  }
  return (
    <section
      className="space-y-2 border-t p-4"
      aria-label={translate('localWorkflow.councilRun.streetCred', 'Street cred')}
    >
      <h4 className="text-xs font-medium text-muted-foreground">
        {translate('localWorkflow.councilRun.streetCredHeading', 'Street cred · average rank')}
      </h4>
      <table className="w-full border-collapse text-left text-sm">
        <thead className="text-xs text-muted-foreground">
          <tr className="border-b">
            <th className="w-12 py-1.5 font-normal">
              {translate('localWorkflow.councilRun.place', 'Place')}
            </th>
            <th className="py-1.5 font-normal">
              {translate('localWorkflow.councilRun.modelColumn', 'Model')}
            </th>
            <th className="py-1.5 text-right font-normal">
              {translate('localWorkflow.councilRun.averageRank', 'Average rank')}
            </th>
            <th className="w-16 py-1.5 text-right font-normal">
              {translate('localWorkflow.councilRun.votesColumn', 'Votes')}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label} className="border-b last:border-0">
              <td className="py-1.5 tabular-nums text-muted-foreground">
                {row.votes ? `#${row.place}` : <NotRanked />}
              </td>
              <td className="py-1.5">
                <span className="flex items-center gap-2">
                  {row.member ? <AgentIcon agent={row.member.agent} size={13} /> : null}
                  {row.member?.modelLabel ?? row.label}
                </span>
              </td>
              <td className="py-1.5 text-right tabular-nums">
                {row.votes ? row.averageRank.toFixed(2) : <NotRanked />}
              </td>
              <td className="py-1.5 text-right tabular-nums text-muted-foreground">{row.votes}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {run.selfVotesExcluded && selfVotesDropped && (
        <p className="text-xs text-muted-foreground">
          {translate(
            'localWorkflow.councilRun.selfVoteNote',
            "A model's vote for its own answer is not counted."
          )}
        </p>
      )}
    </section>
  )
}

/** Stage 2: one tab per voter with the de-anonymised evaluation, then the aggregate. */
export function CouncilRankings({
  view,
  run,
  stageCalls,
  handlers
}: {
  view: LocalWorkflowView
  run: LocalWorkflowCouncilRun
  stageCalls: readonly LocalWorkflowCallView[]
  handlers: WorkflowCallHandlers
}) {
  const voters = run.members.filter((member) => member.votes)
  const answerOnly = run.members.filter((member) => !member.votes)
  const [selected, setSelected] = useState<string>()
  const value = voters.some((voter) => voter.seatId === selected) ? selected : voters[0]?.seatId
  const rankedEveryAnswer = councilReviewersRankedEveryAnswer(view)
  return (
    <div className="rounded-xl border bg-card">
      <p className="px-4 pt-3 text-xs text-muted-foreground">
        {rankedEveryAnswer
          ? translate(
              'localWorkflow.councilRun.rankingExplainer',
              'Each model ranked every answer without knowing who wrote it. Model names are shown here for readability.'
            )
          : translate(
              'localWorkflow.councilRun.rankingExplainerOthers',
              'Each reviewer ranked the other answers anonymously. Model names are shown here for readability.'
            )}
      </p>
      {voters.length > 0 && value ? (
        <Tabs value={value} onValueChange={setSelected} className="gap-0">
          <TabsList
            variant="line"
            aria-label={translate('localWorkflow.councilRun.rankers', 'Rankings by model')}
            className="h-auto w-full justify-start gap-0 overflow-x-auto rounded-none border-b px-2 scrollbar-sleek"
          >
            {voters.map((voter) => {
              const call = councilRankCall(view, run, stageCalls, voter.seatId)
              return (
                <TabsTrigger
                  key={voter.seatId}
                  value={voter.seatId}
                  className="h-9 flex-none gap-1.5 px-3 text-xs"
                >
                  <AgentIcon agent={voter.agent} size={13} />
                  {voter.modelLabel}
                  <WorkflowCallDot call={call} />
                  <span className="sr-only">{call ? callStateLabel(call) : ''}</span>
                </TabsTrigger>
              )
            })}
          </TabsList>
          {voters.map((voter) => (
            <TabsContent key={voter.seatId} value={voter.seatId} className="p-4">
              <Ballot
                run={run}
                seatId={voter.seatId}
                call={councilRankCall(view, run, stageCalls, voter.seatId)}
                subject={voter.modelLabel}
                handlers={handlers}
              />
            </TabsContent>
          ))}
        </Tabs>
      ) : null}
      {answerOnly.length > 0 && (
        <p className="px-4 pb-3 text-xs text-muted-foreground">
          {translate(
            'localWorkflow.councilRun.answersOnly',
            '{{models}}: answers only, never ranks.',
            {
              models: answerOnly.map((member) => member.modelLabel).join(', ')
            }
          )}
        </p>
      )}
      <StreetCred run={run} selfVotesDropped={rankedEveryAnswer} />
    </div>
  )
}
