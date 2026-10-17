import { useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type {
  LocalWorkflowDiscoverRun,
  LocalWorkflowView
} from '../../../../shared/local-workflow-view'
import {
  discoverCallTask,
  discoverFilterCounts,
  discoverFindingsFor,
  type DiscoverFindingFilter,
  type DiscoverReportItem
} from './discover-run-text'
import { DiscoverFindingCard } from './DiscoverFindingCard'
import { DiscoverReport } from './DiscoverReport'
import { discoverFindingAwaitsVotes } from './local-workflow-labels'
import { WorkflowAgentList } from './WorkflowAgentList'
import { WorkflowCallBody, type WorkflowCallHandlers } from './WorkflowCallBody'
import { WorkflowStageItem, WorkflowStageRail } from './WorkflowStageRail'
import { useStageDisclosure } from './use-stage-disclosure'
import { workflowStages, type WorkflowStageModel } from './workflow-run-stages'

function filterLabel(filter: DiscoverFindingFilter): string {
  switch (filter) {
    case 'confirmed':
      return translate('localWorkflow.discoverRun.filterConfirmed', 'Confirmed')
    case 'unverified':
      return translate('localWorkflow.discoverRun.filterUnverified', 'Unverified')
    case 'refuted':
      return translate('localWorkflow.discoverRun.filterRefuted', 'Refuted')
    case 'all':
      return translate('localWorkflow.discoverRun.filterAll', 'All')
  }
}

const FILTERS: readonly DiscoverFindingFilter[] = ['confirmed', 'unverified', 'refuted', 'all']

function DiscoverFindings({
  run,
  searching,
  onOpenLocation
}: {
  run: LocalWorkflowDiscoverRun
  /** The finders may still report more. */
  searching: boolean
  onOpenLocation?: (location: string) => void
}) {
  const [filter, setFilter] = useState<DiscoverFindingFilter>('all')
  const counts = discoverFilterCounts(run.findings)
  const visible = discoverFindingsFor(run.findings, filter)
  if (!run.findings.length) {
    return (
      <p className="text-sm text-muted-foreground">
        {searching
          ? translate('localWorkflow.discoverRun.noneFoundYet', 'Nothing found yet.')
          : translate('localWorkflow.discoverRun.noneFound', 'The finders reported no defects.')}
      </p>
    )
  }
  return (
    <div className="space-y-2">
      <div
        role="group"
        aria-label={translate('localWorkflow.discoverRun.filters', 'Filter findings')}
        className="flex flex-wrap gap-1"
      >
        {FILTERS.map((entry) => (
          <button
            key={entry}
            type="button"
            aria-pressed={filter === entry}
            className={cn(
              'h-6 rounded-full px-2.5 text-xs transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none',
              filter === entry
                ? 'bg-accent font-medium text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            )}
            onClick={() => setFilter(entry)}
          >
            {filterLabel(entry)} <span className="tabular-nums">{counts[entry]}</span>
          </button>
        ))}
      </div>
      {visible.length ? (
        <ul className="space-y-2">
          {visible.map((finding) => (
            <DiscoverFindingCard
              key={finding.id}
              finding={finding}
              onOpenLocation={onOpenLocation}
            />
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">
          {translate('localWorkflow.discoverRun.noneInFilter', 'Nothing here yet.')}
        </p>
      )}
      {run.counts.duplicates > 0 && (
        <p className="text-xs text-muted-foreground">
          {translate(
            'localWorkflow.discoverRun.duplicates',
            'Repeats merged into earlier findings: {{count}}',
            { count: run.counts.duplicates }
          )}
        </p>
      )}
    </div>
  )
}

function stageMeta(stage: WorkflowStageModel, run: LocalWorkflowDiscoverRun): string | undefined {
  switch (stage.id) {
    case 'scout':
      return run.areas.length
        ? translate('localWorkflow.discoverRun.areaCount', '{{count}} areas', {
            count: run.areas.length
          })
        : undefined
    case 'find':
    case 'discover': {
      const found = translate('localWorkflow.discoverRun.foundCount', '{{count}} found', {
        count: run.counts.found
      })
      return run.maxRounds > 1 && run.round > 0
        ? `${found} · ${translate('localWorkflow.discoverRun.round', 'round {{round}} of {{max}}', {
            round: run.round,
            max: run.maxRounds
          })}`
        : found
    }
    case 'verify':
    case 'refute': {
      const tally = translate(
        'localWorkflow.discoverRun.verdictCounts',
        '{{confirmed}} confirmed · {{refuted}} refuted · {{unverified}} unverified',
        {
          confirmed: run.counts.confirmed,
          refuted: run.counts.refuted,
          unverified: run.counts.unverified
        }
      )
      // Findings whose votes have not started wait to verify, as their cards say.
      const waiting = run.findings.filter(
        (finding) => !finding.duplicateOf && discoverFindingAwaitsVotes(finding)
      ).length
      const verifying = Math.max(0, run.counts.verifying - waiting)
      return [
        verifying > 0
          ? translate('localWorkflow.discoverRun.verifyingCount', '{{count}} verifying', {
              count: verifying
            })
          : '',
        waiting > 0
          ? translate('localWorkflow.discoverRun.waitingCount', '{{count}} waiting to verify', {
              count: waiting
            })
          : '',
        tally
      ]
        .filter(Boolean)
        .join(' · ')
    }
    default:
      return undefined
  }
}

type DiscoverViewProps = {
  view: LocalWorkflowView
  run: LocalWorkflowDiscoverRun
  handlers: WorkflowCallHandlers
  onOpenLocation?: (location: string) => void
  onFix?: (item: DiscoverReportItem) => void
  resultFooter?: ReactNode
}

/** Single-call stages (scout, rank): that agent live, then its result, always with Details. */
function singleCallStage(
  stage: WorkflowStageModel,
  handlers: WorkflowCallHandlers,
  result: ReactNode
): ReactNode {
  const call = stage.calls.at(-1)
  if (!call) {
    return result
  }
  return (
    <WorkflowCallBody call={call} subject={call.modelLabel ?? call.seatLabel} {...handlers}>
      {result}
    </WorkflowCallBody>
  )
}

/** Scout's areas; a repeated name (a host quirk) is shown once. */
function AreaChips({ areas }: { areas: LocalWorkflowDiscoverRun['areas'] }) {
  const unique = areas.filter(
    (area, index) => areas.findIndex((other) => other.name === area.name) === index
  )
  return (
    <div className="flex flex-wrap gap-1.5">
      {unique.map((area) => (
        <span
          key={area.name}
          title={area.why}
          className="inline-flex h-6 items-center gap-1.5 rounded-full border px-2.5 text-xs"
        >
          {area.name}
          <span className="tabular-nums text-muted-foreground">{area.files.length}</span>
        </span>
      ))}
    </div>
  )
}

function stageBody(stage: WorkflowStageModel, props: DiscoverViewProps): ReactNode {
  const { view, run, handlers, onOpenLocation } = props
  const agents = (
    <WorkflowAgentList
      calls={stage.calls}
      handlers={handlers}
      describe={(call) => discoverCallTask(call, run)}
    />
  )
  switch (stage.id) {
    case 'scout':
      return singleCallStage(
        stage,
        handlers,
        run.areas.length ? <AreaChips areas={run.areas} /> : undefined
      )
    case 'find':
    case 'discover':
      return (
        <div className="space-y-3">
          {agents}
          <DiscoverFindings
            run={run}
            searching={!['done', 'failed', 'stopped'].includes(stage.tone)}
            onOpenLocation={onOpenLocation}
          />
        </div>
      )
    case 'verify':
    case 'refute':
      return stage.calls.length ? agents : null
    case 'rank':
      return singleCallStage(
        stage,
        handlers,
        run.report || view.result ? (
          <DiscoverReport
            report={run.report}
            fallbackMarkdown={view.result?.markdown}
            completed={view.state === 'completed'}
            onOpenLocation={onOpenLocation}
            onFix={props.onFix}
            footer={view.result ? props.resultFooter : undefined}
          />
        ) : undefined
      )
    default:
      return stage.calls.length ? agents : null
  }
}

/**
 * Scout · Find · Verify · Rank on the live rail; findings fill in as verifiers vote. Work a cap
 * dropped is listed in the run's Notes, below.
 */
export function DiscoverRunView(props: DiscoverViewProps) {
  const { view, run } = props
  const stages = workflowStages(view)
  const disclosure = useStageDisclosure(view, stages)
  return (
    <WorkflowStageRail label={translate('localWorkflow.discoverRun.stages', 'Discover stages')}>
      {stages.map((stage) => (
        <WorkflowStageItem
          key={stage.id}
          stage={stage}
          meta={stageMeta(stage, run)}
          {...disclosure.props(stage)}
        >
          {stageBody(stage, props)}
        </WorkflowStageItem>
      ))}
    </WorkflowStageRail>
  )
}
