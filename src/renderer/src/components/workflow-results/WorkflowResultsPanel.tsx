import { useState } from 'react'
import {
  Combine,
  Crown,
  Hammer,
  Play,
  SearchCheck,
  TrendingUp,
  type LucideIcon
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { LocalWorkflowView } from '../../../../shared/local-workflow-view'
import { findNextSteps, type FindNextStep } from '../../../../shared/find-next-step'
import {
  workflowEvidenceLabel,
  workflowTargetTallyLabel
} from '../workflow-graph/workflow-graph-labels'
import { WorkflowWebChecks } from '../local-workflows/WorkflowWebChecks'
import type {
  WorkflowDecideStatus,
  WorkflowResultCandidate,
  WorkflowResults
} from './workflow-results-candidates'
import {
  WorkflowResultsLaunchDialog,
  type WorkflowResultsTarget
} from './WorkflowResultsLaunchDialog'

const score = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(1))

function checkLabel(check: NonNullable<WorkflowResultCandidate['check']>): string {
  if (check.unavailable) {
    return translate('resultsLaunch.checkUnavailable', 'check could not run')
  }
  const text = check.passed
    ? translate('resultsLaunch.checkPassed', 'check passed')
    : translate('resultsLaunch.checkFailed', 'check failed')
  return check.score !== undefined ? `${text} (SCORE ${check.score})` : text
}

/** How far the final guard and skeptic checked Decide's decision; only "checked" reads as success. */
function DecisionBadge({ status }: { status: WorkflowDecideStatus }) {
  const label = {
    checked: translate('resultsLaunch.decide.badgeChecked', 'passed the guard and the skeptic'),
    warnings: translate(
      'resultsLaunch.decide.badgeWarnings',
      'passed the guard and the skeptic; see the warnings'
    ),
    inconclusive: translate('resultsLaunch.decide.badgeInconclusive', 'guard not decisive'),
    unchecked: translate('resultsLaunch.decide.badgeUnchecked', 'not fully checked'),
    withheld: translate('resultsLaunch.decide.badgeWithheld', 'failed the checks'),
    answer: translate('resultsLaunch.decide.badgeAnswer', 'one model, not checked')
  }[status]
  return (
    <span
      className={cn(
        'rounded px-1 py-px',
        status === 'checked' && 'bg-status-success/15 text-status-success',
        status === 'answer' && 'bg-muted',
        !['checked', 'answer'].includes(status) && 'bg-status-warning/15 text-status-warning'
      )}
    >
      {label}
    </span>
  )
}

function nextStepFace(step: FindNextStep, count: number): [LucideIcon, string] {
  switch (step) {
    case 'improve':
      return [TrendingUp, translate('resultsLaunch.improve', 'Improve it')]
    case 'build':
      return [Hammer, translate('resultsLaunch.build', 'Build with this')]
    case 'combine':
      return [Combine, translate('resultsLaunch.combine', 'Combine these {{count}}', { count })]
    case 'look-closer':
      return [SearchCheck, translate('resultsLaunch.lookCloser', 'Look closer')]
  }
}

/** What the run learned about one result, in a line under its title. */
function Standing({ candidate }: { candidate: WorkflowResultCandidate }) {
  const parts = [
    candidate.rank !== undefined &&
      translate('resultsLaunch.rank', '#{{rank}}', { rank: candidate.rank }),
    candidate.place !== undefined &&
      translate('resultsLaunch.place', 'place {{place}}', { place: candidate.place }),
    candidate.score !== undefined && `JEV ${score(candidate.score)}/4`,
    candidate.notScored && translate('resultsLaunch.notScored', 'not scored by JEV'),
    candidate.check && checkLabel(candidate.check),
    candidate.leads?.length &&
      translate('resultsLaunch.decide.leads', 'led on {{lines}}', {
        lines: candidate.leads.join('; ')
      }),
    candidate.severity,
    candidate.impact &&
      translate('workflowGraph.detail.impact', 'impact {{score}}/5', {
        score: candidate.impact.score
      }),
    candidate.unchecked &&
      !candidate.screened &&
      (candidate.refutedBy === 'jev'
        ? translate('resultsLaunch.uncheckedByJev', 'no reviewer saw it; JEV decided it')
        : translate('resultsLaunch.unchecked', 'no reviewer saw it')),
    candidate.jev && `JEV ${score(candidate.jev.score)}/4`,
    workflowEvidenceLabel(candidate.evidence)
  ].filter((part): part is string => typeof part === 'string' && part.length > 0)
  if (
    !candidate.winner &&
    !candidate.decision &&
    !candidate.tally &&
    !parts.length &&
    !candidate.location
  ) {
    return null
  }
  return (
    <p className="flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
      {candidate.winner ? (
        <span className="flex items-center gap-1 text-foreground">
          <Crown aria-hidden="true" className="size-3" />
          {translate('resultsLaunch.winner', 'winner')}
        </span>
      ) : null}
      {candidate.decision ? <DecisionBadge status={candidate.decision} /> : null}
      {candidate.screened ? (
        <span className="rounded bg-muted px-1 py-px">
          {translate('resultsLaunch.setAside', 'set aside by JEV')}
        </span>
      ) : candidate.tally ? (
        <span
          className={cn(
            'rounded px-1 py-px',
            candidate.tally === 'confirmed' && 'bg-status-success/15 text-status-success',
            candidate.tally === 'refuted' &&
              (candidate.refutedBy === 'jev' ? 'bg-muted' : 'bg-muted line-through'),
            candidate.tally === 'unverified' && 'bg-status-warning/15 text-status-warning'
          )}
        >
          {workflowTargetTallyLabel({ ...candidate, tally: candidate.tally })}
        </span>
      ) : null}
      {parts.map((part) => (
        <span key={part}>{part}</span>
      ))}
      {candidate.location ? (
        <span className="min-w-0 truncate font-mono">{candidate.location}</span>
      ) : null}
    </p>
  )
}

function NextStepButton({
  step,
  count,
  onClick
}: {
  step: FindNextStep
  count: number
  onClick: () => void
}) {
  const [Icon, label] = nextStepFace(step, count)
  return (
    <Button type="button" size="xs" variant="ghost" className="gap-1.5" onClick={onClick}>
      <Icon aria-hidden="true" className="size-3.5" />
      {label}
    </Button>
  )
}

/**
 * A settled run's results to act on: tick the ones that matter (the winner, or the findings that
 * held up, start ticked) and start an agent session with them, or, for Find the best, open
 * Improve or a Council on them to review and start.
 */
export function WorkflowResultsPanel({
  view,
  results,
  target,
  onFindNextStep
}: {
  view: LocalWorkflowView
  results: WorkflowResults
  /** Where a session opens; without it, no session can be started from here. */
  target?: WorkflowResultsTarget
  onFindNextStep?: (step: FindNextStep, keys: string[]) => void
}) {
  const { candidates } = results
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(candidates.filter((candidate) => candidate.preselected).map((entry) => entry.id))
  )
  const [launching, setLaunching] = useState(false)
  const chosen = candidates.filter((candidate) => selected.has(candidate.id))
  const everything = chosen.length === candidates.length
  const nextSteps = results.kind === 'find' && onFindNextStep ? findNextSteps(chosen.length) : []
  if (!target && !onFindNextStep) {
    return null
  }
  const toggle = (id: string, checked: boolean): void =>
    setSelected((previous) => {
      const next = new Set(previous)
      if (checked) {
        next.add(id)
      } else {
        next.delete(id)
      }
      return next
    })
  return (
    <section
      aria-label={translate('resultsLaunch.title', 'Act on the results')}
      className="space-y-2 rounded-lg border bg-card p-3 text-xs"
    >
      <div className="flex items-center gap-2">
        <p className="font-medium">{translate('resultsLaunch.title', 'Act on the results')}</p>
        <span className="text-muted-foreground">
          {translate('resultsLaunch.chosenCount', '{{chosen}} of {{total}} chosen', {
            chosen: chosen.length,
            total: candidates.length
          })}
        </span>
        <Button
          type="button"
          variant="link"
          size="xs"
          className="ml-auto h-auto px-0"
          onClick={() =>
            setSelected(everything ? new Set() : new Set(candidates.map((entry) => entry.id)))
          }
        >
          {everything
            ? translate('resultsLaunch.clear', 'Clear')
            : translate('resultsLaunch.selectAll', 'Select all')}
        </Button>
      </div>
      <ul className="max-h-64 space-y-0.5 overflow-y-auto scrollbar-sleek">
        {candidates.map((candidate) => (
          <li key={candidate.id} className="flex items-start gap-2 py-1">
            <Checkbox
              className="mt-0.5"
              checked={selected.has(candidate.id)}
              aria-label={candidate.title}
              onCheckedChange={(checked) => toggle(candidate.id, checked === true)}
            />
            <div className="min-w-0 flex-1 space-y-0.5">
              <p className="break-words">{candidate.title}</p>
              <Standing candidate={candidate} />
              {candidate.why || candidate.next ? (
                <p className="break-words text-[11px] text-muted-foreground">
                  {/* In a run that reads pages the reason may quote a page: say who wrote it. */}
                  {candidate.webChecks ? (
                    <span className="font-medium" data-model-written="">
                      {`${translate('resultsLaunch.modelWrote', 'The report’s model wrote:')} `}
                    </span>
                  ) : null}
                  {[
                    candidate.why,
                    candidate.next &&
                      translate('resultsLaunch.next', 'Next: {{step}}', { step: candidate.next })
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              ) : null}
              <WorkflowWebChecks checks={candidate.webChecks} compact />
            </div>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-1 border-t pt-2">
        {target ? (
          <Button
            type="button"
            size="xs"
            className="gap-1.5"
            disabled={!chosen.length}
            onClick={() => setLaunching(true)}
          >
            <Play aria-hidden="true" className="size-3.5" />
            {translate('resultsLaunch.startSession', 'Start a session ({{count}})', {
              count: chosen.length
            })}
          </Button>
        ) : null}
        {nextSteps.map((step) => (
          <NextStepButton
            key={step}
            step={step}
            count={chosen.length}
            onClick={() =>
              onFindNextStep?.(
                step,
                chosen.map((candidate) => candidate.key)
              )
            }
          />
        ))}
      </div>
      {launching && target ? (
        <WorkflowResultsLaunchDialog
          target={target}
          view={view}
          results={results}
          chosen={chosen}
          onClose={() => setLaunching(false)}
        />
      ) : null}
    </section>
  )
}
