import { BuildReviewQuestionCard } from './BuildReviewQuestionCard'
import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { useAppStore } from '@/store'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import {
  BUILD_REVIEW_RPC,
  buildReviewEndedWithChangesRequested,
  isBuildReviewActive,
  type BuildReviewPipelineSnapshot,
  type BuildReviewRound,
  type BuildReviewWorkerSnapshot
} from '../../../../shared/build-review-pipeline'
import { BuildReviewActivity } from './BuildReviewActivity'
import { BuildReviewStepper } from './BuildReviewStepper'
import { BuildReviewVerdictBadge } from './BuildReviewVerdict'
import { BuildReviewWaitingRow, BuildReviewWorkerCard } from './BuildReviewWorkerCard'
import { BuildReviewTechnicalDetails } from './BuildReviewTechnicalDetails'
import { BuildReviewWorkspaceHoldNotice } from './BuildReviewWorkspaceHoldNotice'
import { pipelineProblemText, plainFailureText } from './build-review-plain-text'
import {
  buildReviewOutcome,
  buildReviewSteps,
  currentReviewers,
  reviewersOutcome
} from './build-review-progress'

function reviewerTitle(seat: number, count: number): string {
  return count > 1
    ? translate('buildReview.worker.reviewerNumber', 'Reviewer {{number}}', { number: seat })
    : translate('auto.components.build-review.BuildReviewWorkerCard.reviewer', 'Reviewer')
}

function builderTitle(round: number): string {
  return round > 1
    ? translate('buildReview.worker.fixer', 'Builder · fixing findings')
    : translate('auto.components.build-review.BuildReviewWorkerCard.builder', 'Builder')
}

/**
 * The builder and every reviewer of one round; reviewers not yet started are one-line rows. `live`
 * is true only for the current round of a run still going.
 */
function RoundWorkers({
  builder,
  reviewers,
  round,
  live,
  liveTerminal = false,
  worktreeId
}: {
  builder: BuildReviewWorkerSnapshot
  reviewers: readonly BuildReviewWorkerSnapshot[]
  round: number
  live: boolean
  liveTerminal?: boolean
  worktreeId: string | null
}) {
  // Why the seat number is the key: a round's reviewers are a fixed, ordered set of seats, and a
  // seat keeps its place while it goes from waiting to running to reported.
  const seats = reviewers.map((worker, index) => ({ worker, seat: index + 1 }))
  return (
    <div className="space-y-3">
      <BuildReviewWorkerCard
        worker={builder}
        title={builderTitle(round)}
        live={live}
        liveTerminal={liveTerminal}
        worktreeId={worktreeId}
      />
      {seats.map(({ worker, seat }) =>
        worker.status === 'pending' ? (
          <BuildReviewWaitingRow
            key={`seat-${seat}`}
            worker={worker}
            title={reviewerTitle(seat, reviewers.length)}
            waiting={live}
          />
        ) : (
          <BuildReviewWorkerCard
            key={`seat-${seat}`}
            worker={worker}
            title={reviewerTitle(seat, reviewers.length)}
            live={live}
            liveTerminal={liveTerminal}
            worktreeId={worktreeId}
          />
        )
      )}
    </div>
  )
}

/** A folded earlier round: a plain disclosure row, so its worker cards are the only frames. */
function EarlierRound({
  round,
  worktreeId
}: {
  round: BuildReviewRound
  worktreeId: string | null
}) {
  const outcome = reviewersOutcome(round.reviewers)
  return (
    <Collapsible data-build-review-round={round.number}>
      <CollapsibleTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="group h-auto w-full justify-start gap-2 px-3 py-2 text-left"
        >
          <span className="text-sm font-medium">
            {translate('buildReview.roundNumber', 'Round {{round}}', { round: round.number })}
          </span>
          {outcome && <BuildReviewVerdictBadge verdict={outcome} />}
          <ChevronDown
            aria-hidden="true"
            className="ml-auto size-3 text-muted-foreground motion-safe:transition-transform group-data-[state=open]:rotate-180"
          />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="ml-3 border-l pt-2 pl-3">
          <RoundWorkers
            builder={round.builder}
            reviewers={round.reviewers}
            round={round.number}
            live={false}
            worktreeId={worktreeId}
          />
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

/**
 * The run used its last round and the reviewers still asked for changes: its own outcome, not a
 * failure. The findings are in the reviewer cards below; the raw line stays under Details.
 */
function RoundLimitNotice({ pipeline }: { pipeline: BuildReviewPipelineSnapshot }) {
  return (
    <section
      aria-label={translate(
        'buildReview.outcome.roundLimit',
        'Changes requested — round limit reached'
      )}
      data-build-review-outcome="changes-requested"
      className="space-y-1.5 rounded-md border border-status-warning-border bg-status-warning-background p-3 text-sm"
    >
      <p role="status" className="font-medium text-status-warning">
        {translate('buildReview.outcome.roundLimit', 'Changes requested — round limit reached')}
      </p>
      <p className="text-muted-foreground">
        {translate(
          'buildReview.outcome.roundLimitHelp',
          'The reviewers still asked for changes after the last round. Their findings are below: fix them yourself, or choose Retry to run it again.'
        )}
      </p>
      <BuildReviewTechnicalDetails lines={[pipeline.error, pipeline.id, pipeline.runId]} />
    </section>
  )
}

/**
 * A Build + Review run: the objective, a Build → Review → Fix stepper with the round, the
 * current round's workers live, earlier rounds folded away, and the activity log collapsed.
 */
export function BuildReviewDetail({
  pipeline,
  className,
  liveTerminal = false
}: {
  pipeline: BuildReviewPipelineSnapshot
  className?: string
  /**
   * Show the running worker's terminal inline; only a full page can. Elsewhere the worker card
   * offers "Show live terminal", which opens the worker's own terminal tab.
   */
  liveTerminal?: boolean
}) {
  const cancel = useAppStore((s) => s.buildReview.cancel)
  const refreshOne = useAppStore((s) => s.buildReview.refreshOne)
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<{ attempt: string; text: string } | null>(null)
  const question = pipeline.pendingQuestion
  const active = isBuildReviewActive(pipeline.stage)
  // Why per attempt: a refused Retry or Cancel must not stay over a run started again since.
  const attempt = `${pipeline.runId ?? ''}:${active}`
  const error = failure?.attempt === attempt ? failure.text : null
  const round = pipeline.round ?? 1
  const outcome = buildReviewOutcome(pipeline)
  const earlierRounds = (pipeline.rounds ?? []).filter((entry) => entry.number < round)
  const perform = async (action: () => Promise<void>): Promise<void> => {
    setPending(true)
    setFailure(null)
    try {
      await action()
    } catch (error) {
      const text = plainFailureText(error instanceof Error ? error.message : String(error))
      setFailure({ attempt, text })
    } finally {
      setPending(false)
    }
  }
  // Why the same id: the conversation tab and the sidebar stay bound to this run.
  const rerun = (method: string) => async () => {
    await callRuntimeRpc({ kind: 'local' }, method, { id: pipeline.id })
    await refreshOne(pipeline.id)
  }
  const retryable = pipeline.stage === 'failed' || pipeline.stage === 'cancelled'
  const roundLimit = buildReviewEndedWithChangesRequested(pipeline)
  const problem = (roundLimit ? null : pipelineProblemText(pipeline)) ?? error
  return (
    <div className={cn('mx-auto w-full max-w-4xl space-y-5', className)}>
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <h2 className="whitespace-pre-wrap break-words text-base font-semibold">
            {pipeline.objective}
          </h2>
          {/* Why plain text: hub board cards were retired on 2026-09-19, so a link to one no
          longer opens anything; the ID still says what the run was bound to. */}
          {pipeline.hubTaskId && (
            <p className="text-xs text-muted-foreground">
              {translate('buildReview.linkedTask', 'Linked task {{id}}', {
                id: pipeline.hubTaskId
              })}
            </p>
          )}
        </div>
        {active && (
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => void perform(() => cancel(pipeline.id))}
          >
            {translate('auto.components.build-review.BuildReviewDetail.cancel', 'Cancel')}
          </Button>
        )}
        {retryable && (
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => void perform(rerun(BUILD_REVIEW_RPC.retry))}
          >
            {translate('buildReview.retry', 'Retry')}
          </Button>
        )}
      </header>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <BuildReviewStepper steps={buildReviewSteps(pipeline)} />
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {pipeline.round != null && (
            <span className="tabular-nums" data-build-review-round-of>
              {translate('buildReview.roundOf', 'Round {{round}} of {{total}}', {
                round,
                total: pipeline.maxReviewRounds ?? 1
              })}
            </span>
          )}
          {outcome && <BuildReviewVerdictBadge verdict={outcome} />}
        </div>
      </div>
      {problem && (
        <div className="space-y-1.5 rounded-md border border-destructive/40 p-3 text-sm">
          <p role="alert" className="text-destructive">
            {problem}
          </p>
          {error && error !== problem && <p className="text-destructive">{error}</p>}
          <BuildReviewTechnicalDetails
            lines={[
              !roundLimit && pipeline.error !== problem && pipeline.error,
              pipeline.id,
              pipeline.runId
            ]}
          />
        </div>
      )}
      {roundLimit && <RoundLimitNotice pipeline={pipeline} />}
      {!active && (
        <BuildReviewWorkspaceHoldNotice
          pipeline={pipeline}
          pending={pending}
          onRelease={() => void perform(rerun(BUILD_REVIEW_RPC.releaseWorkspace))}
        />
      )}
      {question && (
        <BuildReviewQuestionCard
          key={question.messageId}
          pipelineId={pipeline.id}
          question={question}
        />
      )}
      <RoundWorkers
        builder={pipeline.builder}
        reviewers={currentReviewers(pipeline)}
        round={round}
        live={active}
        liveTerminal={liveTerminal}
        worktreeId={pipeline.worktreeId}
      />
      {earlierRounds.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-xs font-medium text-muted-foreground">
            {translate('buildReview.earlierRounds', 'Earlier rounds')}
          </h3>
          {earlierRounds.map((entry) => (
            <EarlierRound key={entry.number} round={entry} worktreeId={pipeline.worktreeId} />
          ))}
        </section>
      )}
      <BuildReviewActivity events={pipeline.events} />
    </div>
  )
}
