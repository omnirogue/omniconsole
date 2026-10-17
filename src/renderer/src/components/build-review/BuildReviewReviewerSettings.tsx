import type { ReactNode } from 'react'
import type { WorkAgentCapabilityMode } from '@/hooks/useWorkAgentCapabilities'
import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { translate } from '@/i18n/i18n'
import {
  BUILD_REVIEW_MAX_REVIEWERS,
  BUILD_REVIEW_MAX_ROUNDS,
  type BuildReviewAgentChoice
} from '../../../../shared/build-review-pipeline'
import { NEXT_STEP_EXACT_MODEL_AGENTS } from '../next-step/next-step-reviewer-seat'
import { BuildReviewAgentFields } from './BuildReviewAgentFields'
import { BuildReviewSetupRow } from './BuildReviewSetupRow'
import { ReviewRubricPicker } from './ReviewRubricPicker'

export type ReviewerSeat = {
  id: number
  choice: BuildReviewAgentChoice
  /** True once the person picked this seat's agent or model themselves; a proposal is repinnable. */
  chosen?: boolean
  /** Part of the default panel: dropped rather than repeated when the host has too few models. */
  seeded?: boolean
}

export type ReviewerSeatProposer = (seats: readonly ReviewerSeat[]) => BuildReviewAgentChoice | null

/**
 * Without a host answer a new seat is a distinct lineage with no model: a static catalog model
 * would be indistinguishable from one the host verified. The surface pins it once discovery answers.
 */
function unverifiedSeat(seats: readonly ReviewerSeat[]): BuildReviewAgentChoice {
  const taken = new Set(seats.map((seat) => seat.choice.agent))
  return { agent: NEXT_STEP_EXACT_MODEL_AGENTS.find((id) => !taken.has(id)) ?? 'codex' }
}

export function resizeReviewerSeats(
  seats: readonly ReviewerSeat[],
  count: number,
  nextSeat?: ReviewerSeatProposer
): ReviewerSeat[] {
  const next = seats.slice(0, count)
  let id = Math.max(-1, ...seats.map((seat) => seat.id)) + 1
  while (next.length < count) {
    next.push({ id: id++, choice: nextSeat?.(next) ?? unverifiedSeat(next) })
  }
  return next
}

function CountButtons({
  count,
  limit,
  label,
  onSelect
}: {
  count: number
  limit: number
  label: (count: number) => string
  onSelect: (count: number) => void
}) {
  return (
    <>
      {Array.from({ length: limit }, (_, index) => index + 1).map((option) => (
        <Button
          key={option}
          type="button"
          variant={count === option ? 'secondary' : 'outline'}
          size="icon-sm"
          aria-label={label(option)}
          aria-pressed={count === option}
          onClick={() => onSelect(option)}
        >
          {option}
        </Button>
      ))}
    </>
  )
}

/**
 * Reviewer seats and the round limit. `compact` (the Build + Review setup) keeps one control for
 * each: the count group, which shrinks from the end, and the rounds group, with one line of help.
 * Without it (Next actions) each seat can also be removed on its own and rounds typed in.
 */
export function BuildReviewReviewerSettings({
  worktree,
  capabilityMode = 'workspace-launch',
  seats,
  onChange,
  maxRounds,
  onRoundsChange,
  nextSeat,
  idPrefix = 'build-review',
  maxReviewers = BUILD_REVIEW_MAX_REVIEWERS,
  maxRoundsLimit = BUILD_REVIEW_MAX_ROUNDS,
  reviewersRunTogether = false,
  compact = false,
  rubrics = false
}: {
  worktree: string
  capabilityMode?: WorkAgentCapabilityMode
  seats: ReviewerSeat[]
  onChange: (seats: ReviewerSeat[]) => void
  maxRounds: number
  onRoundsChange: (rounds: number) => void
  /** Proposes each added seat; without it a new seat is the next unused lineage at its catalog default. */
  nextSeat?: ReviewerSeatProposer
  /** Keeps field ids unique when another surface renders these controls too. */
  idPrefix?: string
  /** A surface with a smaller runtime limit (Next actions: 5 reviewers, 5 rounds) says so here. */
  maxReviewers?: number
  maxRoundsLimit?: number
  /** Next actions' reviewers share the Settings agent limit; Build + Review starts them all. */
  reviewersRunTogether?: boolean
  /** One control for the reviewer count and one for the rounds, without per-seat help. */
  compact?: boolean
  /** Each seat also picks the rubric it reviews against (Build + Review). */
  rubrics?: boolean
}) {
  const reviewersId = `${idPrefix}-reviewers`
  const roundsId = `${idPrefix}-rounds`
  const seatFields = (seat: ReviewerSeat, index: number) => (
    <>
      <BuildReviewAgentFields
        role={`reviewer-${seat.id}`}
        label={`${translate('buildReview.reviewers.reviewer', 'Reviewer')} ${index + 1}`}
        worktree={worktree}
        capabilityMode={capabilityMode}
        choice={seat.choice}
        {...(compact ? { helpText: null, appearance: 'row' as const } : {})}
        onChange={(choice) =>
          onChange(
            seats.map((item) =>
              item.id === seat.id
                ? {
                    ...item,
                    // The agent fields own agent, model and effort; the rubric stays with the seat.
                    choice: {
                      ...choice,
                      ...(item.choice.rubric ? { rubric: item.choice.rubric } : {})
                    },
                    chosen: true
                  }
                : item
            )
          )
        }
      />
      {rubrics && (
        <BuildReviewSetupRow
          label={translate('buildReview.rubric.label', 'Rubric')}
          htmlFor={`${idPrefix}-rubric-${seat.id}`}
        >
          <ReviewRubricPicker
            id={`${idPrefix}-rubric-${seat.id}`}
            rubric={seat.choice.rubric}
            onChange={(rubric) =>
              onChange(
                seats.map((item) =>
                  item.id === seat.id ? { ...item, choice: { ...item.choice, rubric } } : item
                )
              )
            }
          />
        </BuildReviewSetupRow>
      )}
    </>
  )
  if (compact) {
    return (
      <CompactReviewerSettings
        reviewersId={reviewersId}
        roundsId={roundsId}
        seats={seats}
        maxReviewers={maxReviewers}
        maxRounds={maxRounds}
        maxRoundsLimit={maxRoundsLimit}
        onCount={(count) => onChange(resizeReviewerSeats(seats, count, nextSeat))}
        onRoundsChange={onRoundsChange}
        seatFields={seatFields}
      />
    )
  }
  return (
    <section className="space-y-3">
      <div className="space-y-1">
        <h3 id={reviewersId} className="text-sm font-medium">
          {translate('buildReview.reviewers.title', 'Reviewers')}
        </h3>
        <p className="text-xs text-muted-foreground">
          {reviewersRunTogether
            ? translate(
                'buildReview.reviewers.helpTogether',
                'Selected reviewers check the same change at the same time, up to the agent limit in Settings → Orchestration. Every reviewer must approve before this step completes.'
              )
            : translate(
                'buildReview.reviewers.help',
                'Selected reviewers check the same change at the same time. Every reviewer must approve before this run completes.'
              )}
        </p>
      </div>
      <ButtonGroup aria-labelledby={reviewersId}>
        <CountButtons
          count={seats.length}
          limit={maxReviewers}
          label={(count) => translate('nextStep.reviewerCount', '{{count}} reviewer(s)', { count })}
          onSelect={(count) => onChange(resizeReviewerSeats(seats, count, nextSeat))}
        />
      </ButtonGroup>
      <div className="grid gap-3 sm:grid-cols-2">
        {seats.map((seat, index) => (
          <div key={seat.id} className="space-y-2">
            {seatFields(seat, index)}
            {seats.length > 1 && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`${translate('buildReview.reviewers.remove', 'Remove reviewer')} ${index + 1}`}
                onClick={() => onChange(seats.filter((item) => item.id !== seat.id))}
              >
                {translate('buildReview.reviewers.remove', 'Remove reviewer')}
              </Button>
            )}
          </div>
        ))}
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={seats.length >= maxReviewers}
        onClick={() => onChange(resizeReviewerSeats(seats, seats.length + 1, nextSeat))}
      >
        {translate('buildReview.reviewers.add', 'Add reviewer')}
      </Button>
      <div className="space-y-2">
        <Label htmlFor={roundsId}>
          {translate('buildReview.reviewers.rounds', 'Maximum review rounds')}
        </Label>
        <ButtonGroup aria-describedby={`${roundsId}-help`}>
          <CountButtons
            count={maxRounds}
            limit={maxRoundsLimit}
            label={(count) => translate('nextStep.roundCount', '{{count}} round(s)', { count })}
            onSelect={onRoundsChange}
          />
        </ButtonGroup>
        <Input
          id={roundsId}
          type="number"
          min={1}
          max={maxRoundsLimit}
          step={1}
          placeholder={`1–${maxRoundsLimit}`}
          required
          value={Number.isNaN(maxRounds) ? '' : maxRounds}
          aria-describedby={`${roundsId}-help`}
          onChange={(event) => onRoundsChange(event.target.valueAsNumber)}
        />
        <p id={`${roundsId}-help`} className="text-xs text-muted-foreground">
          {translate(
            'buildReview.reviewers.roundsHelp',
            'One round means a build or repair followed by every review. Findings go back to the builder for repair, then everyone reviews again. Stop early when all approve; at this limit, stop and show any unresolved findings.'
          )}
        </p>
      </div>
    </section>
  )
}

/**
 * The Build + Review setup's reviewer rows: one count control, one quiet row per seat and one
 * rounds control, drawn like the Council and Discover composers.
 */
function CompactReviewerSettings({
  reviewersId,
  roundsId,
  seats,
  maxReviewers,
  maxRounds,
  maxRoundsLimit,
  onCount,
  onRoundsChange,
  seatFields
}: {
  reviewersId: string
  roundsId: string
  seats: ReviewerSeat[]
  maxReviewers: number
  maxRounds: number
  maxRoundsLimit: number
  onCount: (count: number) => void
  onRoundsChange: (rounds: number) => void
  seatFields: (seat: ReviewerSeat, index: number) => ReactNode
}) {
  return (
    <section className="space-y-4">
      <BuildReviewSetupRow
        label={translate('buildReview.reviewers.title', 'Reviewers')}
        labelId={reviewersId}
      >
        <ButtonGroup aria-labelledby={reviewersId}>
          <CountButtons
            count={seats.length}
            limit={maxReviewers}
            label={(count) =>
              translate('nextStep.reviewerCount', '{{count}} reviewer(s)', { count })
            }
            onSelect={onCount}
          />
        </ButtonGroup>
        <p className="text-xs text-muted-foreground">
          {translate(
            'buildReview.reviewers.help',
            'Selected reviewers check the same change at the same time. Every reviewer must approve before this run completes.'
          )}
        </p>
      </BuildReviewSetupRow>
      {seats.map((seat, index) => (
        <div key={seat.id}>{seatFields(seat, index)}</div>
      ))}
      <BuildReviewSetupRow label={translate('buildReview.reviewers.roundsShort', 'Rounds')}>
        <ButtonGroup
          aria-label={translate('buildReview.reviewers.rounds', 'Maximum review rounds')}
          aria-describedby={`${roundsId}-help`}
        >
          <CountButtons
            count={maxRounds}
            limit={maxRoundsLimit}
            label={(count) => translate('nextStep.roundCount', '{{count}} round(s)', { count })}
            onSelect={onRoundsChange}
          />
        </ButtonGroup>
        <p id={`${roundsId}-help`} className="text-xs text-muted-foreground">
          {translate(
            'buildReview.reviewers.roundsHelpShort',
            'A round is a build or fix, then every review. It stops as soon as everyone approves.'
          )}
        </p>
      </BuildReviewSetupRow>
    </section>
  )
}
