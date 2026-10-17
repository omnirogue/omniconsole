import { WorkflowCallTabs } from './WorkflowCallTabs'
import { WorkflowCouncilFinalCheck } from './WorkflowCouncilFinalCheck'
import { useState } from 'react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type {
  LocalWorkflowCallView,
  LocalWorkflowGraphItem,
  LocalWorkflowGraphRound,
  LocalWorkflowGraphRun,
  LocalWorkflowView
} from '../../../../shared/local-workflow-view'
import type { WorkflowCallHandlers } from '../local-workflows/WorkflowCallBody'
import {
  WORKFLOW_STATE_DOT,
  workflowKindHint,
  workflowStateLabel,
  workflowTargetTallyLabel,
  workflowVerdictLabel
} from './workflow-graph-labels'
import { WorkflowTargetMarks } from './WorkflowTargetMarks'
import { WorkflowJudgeCheckLine } from './WorkflowJudgeCheckLine'
import { workflowDecisionPoints } from '../../../../shared/decision-contracts/decision-points'

type Step = LocalWorkflowGraphRun['steps'][number]
const VERDICT_MARK = { pass: '✓', fail: '✗', unsure: '?' } as const

/** Reports merged into an item that were not exact copies: a merge never hides a claim. */
function AlsoReported({ item }: { item: LocalWorkflowGraphItem }) {
  if (!item.alsoReported?.length) {
    return null
  }
  return (
    <div className="mt-1 text-xs text-muted-foreground">
      {translate('workflowGraph.detail.alsoReported', 'Also reported as:')}
      <ul className="ml-3 list-disc">
        {item.alsoReported.map((other) => (
          <li key={`${other.title}\u0000${other.detail}`} title={other.detail}>
            {other.title}
            {other.location ? <span className="ml-1 font-mono">{other.location}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  )
}

function Items({
  round,
  onOpenLocation
}: {
  round: LocalWorkflowGraphRound
  onOpenLocation?: (location: string) => void
}) {
  if (!round.items?.length) {
    return null
  }
  return (
    <ol className="space-y-1.5 text-sm">
      {round.items.map((item) => (
        <li key={item.key} className="rounded-md border px-2.5 py-1.5">
          <span className="font-medium">{item.title}</span>
          {item.severity !== 'none' ? (
            <span className="ml-1.5 text-xs text-muted-foreground">
              {item.severity}
              {item.reportedSeverity
                ? ` ${translate('workflowGraph.detail.firstReported', '(first reported {{severity}})', { severity: item.reportedSeverity })}`
                : null}
            </span>
          ) : null}
          {item.location ? (
            <button
              type="button"
              className="ml-1.5 font-mono text-xs text-muted-foreground underline-offset-2 hover:underline"
              onClick={() => onOpenLocation?.(item.location)}
            >
              {item.location}
            </button>
          ) : null}
          {item.repeats ? (
            <span className="ml-1.5 text-xs text-muted-foreground">
              {translate('workflowGraph.detail.repeats', '+{{count}} same', {
                count: item.repeats
              })}
            </span>
          ) : null}
          <p className="mt-0.5 line-clamp-3 text-xs text-muted-foreground">{item.detail}</p>
          <AlsoReported item={item} />
        </li>
      ))}
    </ol>
  )
}

function Targets({
  step,
  round,
  calls,
  handlers,
  onOpenLocation
}: {
  step: Step
  round: LocalWorkflowGraphRound
  calls: ReadonlyMap<string, LocalWorkflowCallView>
  handlers: WorkflowCallHandlers
  onOpenLocation?: (location: string) => void
}) {
  const [open, setOpen] = useState<string>()
  return (
    <ol className="space-y-1.5">
      {(round.targets ?? []).map((target) => (
        <li key={target.key} className="rounded-md border px-2.5 py-1.5 text-sm">
          <button
            type="button"
            className="flex w-full items-center gap-2 text-left"
            onClick={() => setOpen(open === target.key ? undefined : target.key)}
          >
            <span
              className={cn(
                'rounded px-1.5 py-0.5 text-[11px]',
                target.tally === 'confirmed' && 'bg-status-success/15 text-status-success',
                target.tally === 'refuted' &&
                  (target.refutedBy === 'jev'
                    ? 'bg-muted text-muted-foreground'
                    : 'bg-muted text-muted-foreground line-through'),
                target.tally === 'unverified' && 'bg-status-warning/15 text-status-warning'
              )}
            >
              {workflowTargetTallyLabel(target)}
            </span>
            <WorkflowTargetMarks target={target} />
            <span className="min-w-0 flex-1 truncate font-medium">{target.title}</span>
            <span
              aria-label={target.votes.map(workflowVerdictLabel).join(', ')}
              className="font-mono text-xs text-muted-foreground"
            >
              {target.votes.map((vote) => (vote ? VERDICT_MARK[vote] : '·')).join(' ')}
            </span>
          </button>
          {target.location ? (
            <button
              type="button"
              className="font-mono text-xs text-muted-foreground hover:underline"
              onClick={() => onOpenLocation?.(target.location)}
            >
              {target.location}
            </button>
          ) : null}
          {open === target.key && (
            <div className="mt-2 space-y-2">
              <p className="whitespace-pre-wrap text-xs text-muted-foreground">{target.detail}</p>
              <AlsoReported item={target} />
              <WorkflowCallTabs
                step={step}
                round={round}
                calls={calls}
                handlers={handlers}
                filter={(id) => id.includes(`/${target.key}/`)}
              />
            </div>
          )}
        </li>
      ))}
    </ol>
  )
}

/** One step of a run: what it does, its state, and each agent's live work and answer. */
export function WorkflowStepDetail({
  view,
  step,
  handlers,
  onOpenLocation
}: {
  view: LocalWorkflowView
  step: Step
  handlers: WorkflowCallHandlers
  onOpenLocation?: (location: string) => void
}) {
  const graphRun = view.graphRun!
  const spec = graphRun.spec.steps.find((entry) => entry.id === step.id)!
  const [roundIndex, setRoundIndex] = useState<number>()
  const round = step.rounds[roundIndex ?? step.rounds.length - 1] ?? step.rounds.at(-1)!
  const calls = new Map(view.calls.map((call) => [call.id, call]))
  const contracts = graphRun.contracts ?? []
  const checks = workflowDecisionPoints(graphRun.spec)
    .filter((point) => point.stepId === step.id)
    .flatMap((point) => contracts.filter((entry) => entry.point === point.key))
  return (
    <section aria-label={spec.title} className="space-y-3 rounded-xl border bg-card p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn('size-2 rounded-full', WORKFLOW_STATE_DOT[step.state])} />
        <h4 className="text-sm font-medium">{spec.title}</h4>
        <span className="text-xs text-muted-foreground">{workflowStateLabel(step.state)}</span>
        {step.rounds.length > 1 && (
          <span className="ml-auto flex gap-1">
            {step.rounds.map((entry, index) => (
              <button
                key={entry.round}
                type="button"
                aria-pressed={round === entry}
                className={cn('rounded border px-1.5 text-xs', round === entry && 'bg-accent')}
                onClick={() => setRoundIndex(index)}
              >
                {translate('workflowGraph.detail.round', 'Round {{round}}', { round: entry.round })}
              </button>
            ))}
          </span>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {spec.instruction || workflowKindHint(spec.kind)}
      </p>
      {checks.map((check) => (
        <WorkflowJudgeCheckLine key={check.point} check={check} />
      ))}
      {round.finalCheck && (
        <WorkflowCouncilFinalCheck
          check={round.finalCheck}
          judgeCheck={contracts.find((entry) => entry.point === 'final-check')}
        />
      )}
      {round.reason && <p className="text-xs text-muted-foreground">{round.reason}</p>}
      {round.standings?.length ? (
        <table className="w-full text-xs">
          <thead className="text-muted-foreground">
            <tr>
              <th className="text-left font-normal">
                {translate('workflowGraph.detail.place', 'Place')}
              </th>
              <th className="text-left font-normal">
                {translate('workflowGraph.detail.model', 'Model')}
              </th>
              <th className="text-right font-normal">
                {translate('workflowGraph.detail.averageRank', 'Average rank')}
              </th>
              <th className="text-right font-normal">
                {translate('workflowGraph.detail.votes', 'Votes')}
              </th>
            </tr>
          </thead>
          <tbody>
            {round.standings.map((standing) => (
              <tr key={standing.label}>
                <td>{standing.votes ? standing.place : '—'}</td>
                <td>{`${standing.name} (${standing.label})`}</td>
                <td className="text-right">
                  {standing.votes ? standing.averageRank.toFixed(2) : '—'}
                </td>
                <td className="text-right">{standing.votes}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {round.targets ? (
        <Targets
          step={step}
          round={round}
          calls={calls}
          handlers={handlers}
          onOpenLocation={onOpenLocation}
        />
      ) : (
        <>
          <Items round={round} onOpenLocation={onOpenLocation} />
          <WorkflowCallTabs step={step} round={round} calls={calls} handlers={handlers} />
        </>
      )}
      {round.notes.length > 0 && (
        <ul className="space-y-0.5 text-xs text-muted-foreground">
          {round.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
    </section>
  )
}
