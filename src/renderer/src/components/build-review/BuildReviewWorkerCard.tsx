import { AgentStateDot, type AgentDotState } from '@/components/AgentStateDot'
import { Badge } from '@/components/ui/badge'
import { translate } from '@/i18n/i18n'
import { AgentIcon } from '@/lib/agent-catalog'
import { ModelDot } from '@/components/ModelDot'
import { useAppStore } from '@/store'
import type { BuildReviewWorkerSnapshot } from '../../../../shared/build-review-pipeline'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import { buildReviewStatusLabel } from './build-review-labels'
import { buildReviewEffortParityLine } from './build-review-effort-parity-line'
import { workerVerdict } from './build-review-progress'
import {
  findWorkerStatusRow,
  isWorkerLive,
  workerDisplayStatus,
  workerDotState
} from './build-review-worker-live'
import { BuildReviewVerdictBadge } from './BuildReviewVerdict'
import { BuildReviewWorkerLiveStatus, BuildReviewWorkerLiveTerminal } from './BuildReviewWorkerLive'
import { BuildReviewWorkerReport } from './BuildReviewWorkerReport'
import { workerProblemText } from './build-review-plain-text'
import { BuildReviewOpenTerminalButton } from './BuildReviewOpenTerminalButton'
import { BuildReviewTechnicalDetails } from './BuildReviewTechnicalDetails'

function choiceLine(worker: BuildReviewWorkerSnapshot): string {
  return [worker.choice.agent, worker.choice.model, worker.choice.effort]
    .filter(Boolean)
    .join(' · ')
}

function roleTitle(worker: BuildReviewWorkerSnapshot): string {
  return worker.role === 'builder'
    ? translate('auto.components.build-review.BuildReviewWorkerCard.builder', 'Builder')
    : translate('auto.components.build-review.BuildReviewWorkerCard.reviewer', 'Reviewer')
}

/**
 * One worker: who it is, its live state, what it reported and a way into its terminal. With
 * `live`, a started worker follows its agent hooks (state dot, current tool, elapsed time, last
 * words); with `liveTerminal` too, it shows its terminal inline. The other optional props let a
 * surface whose nodes are not the builder/reviewer pair — a local Run's graph node — show the
 * same card.
 */
export function BuildReviewWorkerCard({
  worker,
  title,
  badge,
  state,
  details,
  live = false,
  liveTerminal = false,
  worktreeId,
  children
}: {
  worker: BuildReviewWorkerSnapshot
  /** The run's workspace, so a report file the worker names can be opened. */
  worktreeId?: string | null
  /** Heading override; defaults to the worker's role. */
  title?: string
  /** Status badge override; defaults to the review verdict or the worker status. */
  badge?: string
  /** State glyph beside the heading; with `live` it defaults to the worker's hook state. */
  state?: AgentDotState
  /** Extra rows under the report: workspace folder, manifest, delivery receipt. */
  details?: { label: string; value: string }[]
  /** Follow the worker's agent hooks while it runs. */
  live?: boolean
  /**
   * Show the running worker's terminal inline. Only a full page can: the terminal is borrowed
   * through the portal Terminal honours on those pages (viewHostsTerminalPortals). A workspace tab
   * cannot borrow it without pulling it out of its own tab, so there "Show live terminal" opens
   * the worker's terminal tab instead.
   */
  liveTerminal?: boolean
  children?: React.ReactNode
}) {
  const handle = worker.terminalHandle
  // Why keyed by attempt: a Retry reuses this card; the last attempt's open error must not stay.
  const attempt = `${worker.dispatchId ?? ''}:${handle ?? ''}`
  const row = useAppStore((store) =>
    live ? findWorkerStatusRow(store.agentStatusByPaneKey, handle) : null
  )
  const following = live && isWorkerLive(worker)
  const dot = state ?? (live ? workerDotState(worker, row) : undefined)
  const verdict = workerVerdict(worker)
  const parityLine = buildReviewEffortParityLine(worker.effortParity)
  const heading = title ?? roleTitle(worker)
  const problem = workerProblemText(worker)
  // A startup question the run is waiting on is the person's turn, not a failure.
  const waitingOnPerson = Boolean(worker.startupBlocker) && isWorkerLive(worker)
  return (
    <section
      aria-label={heading}
      data-build-review-worker={worker.role}
      data-status={worker.status}
      className="min-w-0 space-y-3 rounded-lg border bg-card p-4 text-sm"
    >
      <header className="flex items-start gap-3">
        <span className="mt-0.5 flex shrink-0 items-center gap-1.5">
          <ModelDot agent={worker.choice.agent} model={worker.choice.model} />
          <AgentIcon
            agent={isTuiAgent(worker.choice.agent) ? worker.choice.agent : null}
            size={16}
          />
        </span>
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="truncate font-medium">{heading}</h3>
            {dot && <AgentStateDot state={dot} />}
          </div>
          <p className="truncate font-mono text-[11px] text-muted-foreground">
            {choiceLine(worker)}
          </p>
          {/* Why beside the actor line: the line above is the request, and a verdict
          produced at another effort has to be read with that in view. */}
          {parityLine && (
            <p
              className="text-xs text-status-warning"
              data-build-review-effort-parity={worker.effortParity?.state}
            >
              {parityLine}
            </p>
          )}
        </div>
        {badge === undefined && verdict ? (
          <BuildReviewVerdictBadge verdict={verdict} className="shrink-0" />
        ) : (
          <Badge variant="secondary" className="shrink-0">
            {badge ?? buildReviewStatusLabel(workerDisplayStatus(worker, row))}
          </Badge>
        )}
      </header>
      {following && <BuildReviewWorkerLiveStatus worker={worker} row={row} />}
      {worker.report && (
        <BuildReviewWorkerReport
          report={worker.report}
          role={worker.role}
          worktreeId={worktreeId}
          findings={worker.findings ?? null}
        />
      )}
      {!!details?.length && (
        <dl className="space-y-2">
          {details.map((detail) => (
            <div key={detail.label} className="space-y-0.5">
              <dt className="text-xs text-muted-foreground">{detail.label}</dt>
              <dd className="break-all font-mono text-xs">{detail.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {children}
      {problem && (
        <div className="space-y-1">
          <p
            role={waitingOnPerson ? 'status' : 'alert'}
            className={waitingOnPerson ? 'text-status-warning' : 'text-destructive'}
          >
            {problem}
          </p>
          {worker.startupBlocker && (
            <p className="text-xs text-muted-foreground">
              {waitingOnPerson
                ? translate(
                    'buildReview.blocker.continues',
                    'The run goes on by itself once you have answered it.'
                  )
                : translate(
                    'buildReview.blocker.next',
                    'When you have answered it, close that terminal and choose Retry.'
                  )}
            </p>
          )}
          <BuildReviewTechnicalDetails
            lines={[
              worker.error !== problem && worker.error,
              worker.startupBlocker,
              worker.dispatchId
            ]}
          />
        </div>
      )}
      {worker.terminalClosed ? (
        <p className="text-xs text-muted-foreground" data-build-review-terminal="closed">
          {translate('buildReview.worker.terminalGone', 'Its terminal is closed.')}
        </p>
      ) : following && liveTerminal && handle ? (
        <BuildReviewWorkerLiveTerminal
          handle={handle}
          actions={<BuildReviewOpenTerminalButton key={attempt} handle={handle} />}
        />
      ) : following && handle ? (
        <div className="flex flex-wrap items-center gap-2">
          <BuildReviewOpenTerminalButton key={attempt} handle={handle} live />
          <span className="text-xs text-muted-foreground">
            {translate('buildReview.live.opensTab', "Opens the worker's terminal in its own tab.")}
          </span>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <BuildReviewOpenTerminalButton key={attempt} handle={handle} />
        </div>
      )}
    </section>
  )
}

/**
 * A reviewer that has not started: one quiet row instead of an empty card. While the run goes on
 * its turn is still to come; once the run stopped (failed, cancelled, an earlier round) it never
 * ran, and "Waiting" would promise a turn that will not come.
 */
export function BuildReviewWaitingRow({
  worker,
  title,
  waiting = true
}: {
  worker: BuildReviewWorkerSnapshot
  title: string
  waiting?: boolean
}) {
  return (
    <div
      data-build-review-waiting={waiting ? 'waiting' : 'not-run'}
      className="flex min-w-0 items-center gap-2 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground"
    >
      <ModelDot agent={worker.choice.agent} model={worker.choice.model} />
      <AgentIcon agent={isTuiAgent(worker.choice.agent) ? worker.choice.agent : null} size={12} />
      <span className="shrink-0 font-medium text-foreground">{title}</span>
      <span className="min-w-0 truncate font-mono text-[11px]">{choiceLine(worker)}</span>
      <span className="ml-auto shrink-0">
        {waiting
          ? translate('buildReview.worker.waiting', 'Waiting')
          : translate('buildReview.worker.notRun', 'Did not run')}
      </span>
    </div>
  )
}
