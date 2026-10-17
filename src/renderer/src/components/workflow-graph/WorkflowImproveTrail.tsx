import { Star, X } from 'lucide-react'
import { ModelDot } from '@/components/ModelDot'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { LocalWorkflowSeatView } from '../../../../shared/local-workflow-view'
import type {
  WorkflowImproveCandidate,
  WorkflowImproveRound,
  WorkflowLoopView
} from '../../../../shared/workflow-improve-trail'
import { WorkflowImproveFinalTest } from './WorkflowImproveFinalTest'
import { WorkflowImprovePredictionNotes } from './WorkflowImprovePredictionNotes'

function roleLabel(role: WorkflowImproveCandidate['role']): string {
  switch (role) {
    case 'best':
      return translate('workflowGraph.trail.roleBest', 'best so far')
    case 'first':
      return translate('workflowGraph.trail.roleFirst', 'first version')
    case 'improve':
      return translate('workflowGraph.trail.roleImprove', 'improves the best')
    case 'explore':
      return translate('workflowGraph.trail.roleExplore', 'explores')
    case 'divergent':
      return translate('workflowGraph.trail.roleDivergent', 'different approach')
  }
}

/** Several versions to build on: which one this version built on. */
function parentLabel(parent: NonNullable<WorkflowImproveCandidate['parent']>): string {
  return parent.round === 0
    ? translate('workflowGraph.trail.parentUnchanged', 'builds on your code as it is')
    : translate('workflowGraph.trail.parent', 'builds on {{name}}, round {{round}}', {
        name: parent.name,
        round: parent.round
      })
}

function judgedBy(round: WorkflowImproveRound): string {
  const byCheck = round.judgedBy.includes('check')
  const judges = judgedByJudges(round)
  return byCheck
    ? judges
      ? translate('workflowGraph.trail.checkThen', 'check, then {{judges}}', { judges })
      : translate('workflowGraph.trail.check', 'check')
    : judges
}

function judgedByJudges(round: WorkflowImproveRound): string {
  const jev = round.judgedBy.includes('jev')
  const models = round.judgedBy.includes('models')
  if (jev && models) {
    return !round.jevUnsure
      ? translate('workflowGraph.trail.both', 'JEV + models')
      : round.jevCounted
        ? translate('workflowGraph.trail.jevUnsureCounted', 'JEV (unsure) + models')
        : translate('workflowGraph.trail.jevUnsure', 'JEV unsure → models')
  }
  return jev
    ? translate('workflowGraph.trail.jev', 'JEV')
    : models
      ? translate('workflowGraph.trail.models', 'models')
      : ''
}

function outcome(round: WorkflowImproveRound): { text: string; good: boolean } {
  switch (round.result) {
    case 'first':
      return { text: translate('workflowGraph.trail.first', 'first best version'), good: true }
    case 'new-best':
      return round.noGain
        ? {
            text: translate(
              'workflowGraph.trail.newBestNoGain',
              'new best · no better test result'
            ),
            good: true
          }
        : { text: translate('workflowGraph.trail.newBest', 'new best'), good: true }
    case 'kept':
      return { text: translate('workflowGraph.trail.kept', 'no gain · best kept'), good: false }
    case 'unjudged':
      return {
        text: translate('workflowGraph.trail.unjudged', 'not judged · best kept'),
        good: false
      }
    case 'failed':
      return { text: translate('workflowGraph.trail.failed', 'nothing came back'), good: false }
    case 'pending':
      return { text: translate('workflowGraph.trail.running', 'working…'), good: false }
  }
}

function stopReason(loop: WorkflowLoopView): string | undefined {
  const trail = loop.improve!
  switch (trail.stop) {
    case 'undecided':
      return translate(
        'workflowGraph.trail.undecided',
        'Stopped: two rounds in a row could not be judged'
      )
    case 'plateau':
      return trail.measured
        ? translate(
            'workflowGraph.trail.plateauMeasured',
            'Stopped: {{count}} rounds in a row brought no better test result',
            { count: trail.patience }
          )
        : translate(
            'workflowGraph.trail.plateau',
            'Stopped: {{count}} rounds in a row brought no gain',
            { count: trail.patience }
          )
    case 'max-rounds':
      return translate('workflowGraph.trail.maxRounds', 'Stopped at the round limit ({{count}})', {
        count: loop.maxRounds
      })
    case 'verified':
      return translate('workflowGraph.trail.verified', 'Stopped: the best version passes the check')
    case 'passing-kept':
      return translate(
        'workflowGraph.trail.passingKept',
        'Stopped: every practice case passes, and the judges preferred the best version to each new change'
      )
    case 'failed':
      return translate('workflowGraph.trail.stoppedEarly', 'Stopped early')
    case undefined:
      return undefined
  }
}

/**
 * The Improve search as it happened: each round (sequential) with its versions (made in
 * parallel), who judged, what was kept, and why the search stopped. The best version is always
 * the one held, never simply the newest.
 */
export function WorkflowImproveTrail({
  loop,
  seats
}: {
  loop: WorkflowLoopView
  /** Every seat of the run, to colour each version by its model. */
  seats: readonly LocalWorkflowSeatView[]
}) {
  const trail = loop.improve!
  const seat = (seatId: string) => seats.find((entry) => entry.seatId === seatId)
  const stop = stopReason(loop)
  return (
    <section
      aria-label={translate('workflowGraph.trail.title', 'Search')}
      className="space-y-2 rounded-lg border bg-card p-3 text-xs"
    >
      <p className="font-medium">
        {translate('workflowGraph.trail.title', 'Search')}
        <span className="ml-2 font-normal text-muted-foreground">
          {translate('workflowGraph.trail.progress', 'round {{round}} of up to {{max}}', {
            round: loop.round,
            max: loop.maxRounds
          })}
        </span>
      </p>
      <ol className="space-y-1.5 border-l pl-3">
        {trail.rounds.map((round) => {
          const result = outcome(round)
          const by = judgedBy(round)
          return (
            <li key={round.round} className="space-y-1">
              <p className="flex flex-wrap items-center gap-x-2 text-muted-foreground">
                <span className="font-medium text-foreground">
                  {round.mode === 'divergent'
                    ? translate(
                        'workflowGraph.trail.divergentRound',
                        'Round {{round}} · different approaches',
                        {
                          round: round.round
                        }
                      )
                    : translate('workflowGraph.trail.round', 'Round {{round}}', {
                        round: round.round
                      })}
                </span>
                {by ? <span>{by}</span> : null}
                {round.escalated ? (
                  <span>{translate('workflowGraph.trail.frontier', 'frontier models')}</span>
                ) : null}
                <span className={cn(result.good && 'text-status-success')}>{result.text}</span>
                {round.agreed === false ? (
                  <span className="text-status-warning">
                    {translate('workflowGraph.trail.disagreed', 'JEV and models disagreed')}
                  </span>
                ) : null}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {round.candidates.map((candidate) => {
                  const view = seat(candidate.seatId)
                  return (
                    <span
                      key={candidate.label}
                      title={`${candidate.name} · ${roleLabel(candidate.role)}${candidate.place ? ` · place ${candidate.place}` : ''}`}
                      className={cn(
                        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5',
                        candidate.accepted && 'border-status-success font-medium',
                        candidate.role === 'best' && !candidate.accepted && 'border-dashed'
                      )}
                    >
                      {candidate.accepted ? (
                        <Star aria-hidden="true" className="size-3 text-status-success" />
                      ) : round.result !== 'pending' && candidate.role !== 'best' ? (
                        <X aria-hidden="true" className="size-3 text-muted-foreground" />
                      ) : null}
                      <ModelDot agent={view?.agent} model={view?.model} />
                      <span>{view?.modelLabel ?? candidate.name}</span>
                      <span className="text-muted-foreground">{roleLabel(candidate.role)}</span>
                      {candidate.parent ? (
                        <span className="text-muted-foreground">
                          {parentLabel(candidate.parent)}
                        </span>
                      ) : null}
                      {candidate.check ? <CheckBadge check={candidate.check} /> : null}
                      {candidate.check?.exits ? (
                        <span className="text-status-warning">
                          {translate('workflowGraph.trail.checkExits', 'adds {{calls}}', {
                            calls: candidate.check.exits.join(', ')
                          })}
                        </span>
                      ) : null}
                    </span>
                  )
                })}
              </div>
              <WorkflowImprovePredictionNotes
                candidates={round.candidates}
                name={(candidate) => seat(candidate.seatId)?.modelLabel ?? candidate.name}
              />
              {round.reason ? <p className="text-muted-foreground">{round.reason}</p> : null}
            </li>
          )
        })}
      </ol>
      {stop ? <p className="text-muted-foreground">{stop}</p> : null}
      {trail.final ? <WorkflowImproveFinalTest final={trail.final} /> : null}
      {trail.best && trail.stop ? (
        <p className="flex items-center gap-1.5 font-medium">
          <Star aria-hidden="true" className="size-3.5 text-status-success" />
          {trail.best.round === 0
            ? translate(
                'workflowGraph.trail.bestUnchanged',
                'Nothing beat your code as it is, so it stays unchanged (the result below)'
              )
            : translate(
                'workflowGraph.trail.best',
                'Best discovered: {{name}}, round {{round}} (the result below)',
                {
                  name: seat(trail.best.seatId)?.modelLabel ?? trail.best.name,
                  round: trail.best.round
                }
              )}
        </p>
      ) : null}
    </section>
  )
}

function CheckBadge({ check }: { check: NonNullable<WorkflowImproveCandidate['check']> }) {
  if (check.unavailable) {
    return (
      <span className="text-status-warning">
        {translate('workflowGraph.trail.checkUnavailable', 'check could not run')}
      </span>
    )
  }
  const score = check.score !== undefined ? ` ${check.score}` : ''
  if (check.cases) {
    return (
      <span className={check.passed ? 'text-status-success' : 'text-muted-foreground'}>
        {translate('workflowGraph.trail.checkCases', '{{passed}}/{{total}} cases{{score}}', {
          passed: check.cases.passed,
          total: check.cases.total,
          score
        })}
      </span>
    )
  }
  return check.passed ? (
    <span className="text-status-success">
      {translate('workflowGraph.trail.checkPassed', 'passes{{score}}', { score })}
    </span>
  ) : (
    <span className="text-muted-foreground">
      {translate('workflowGraph.trail.checkFailed', 'fails{{score}}', { score })}
    </span>
  )
}
