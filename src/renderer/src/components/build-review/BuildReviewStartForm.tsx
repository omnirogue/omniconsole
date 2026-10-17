import { folderWorkspaceToWorktree } from '../../../../shared/folder-workspace-worktree'
import { HUB_TASK_ID_PATTERN } from '../../../../shared/omnios-task-binding'
import { useState } from 'react'
import { useAppStore } from '@/store'
import { useAllWorktrees } from '@/store/selectors'
import { Button } from '@/components/ui/button'
import { DialogFooter } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { translate } from '@/i18n/i18n'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import {
  BUILD_REVIEW_MAX_ROUNDS,
  type BuildReviewAgentChoice,
  type BuildReviewStartRequest
} from '../../../../shared/build-review-pipeline'
import { useWorkAgentCapabilities } from '@/hooks/useWorkAgentCapabilities'
import type { NextStepActor } from '../../../../shared/next-step-draft'
import { nextReviewerSeat } from '../next-step/next-step-reviewer-seat'
import { BuildReviewAdvancedFields } from './BuildReviewAdvancedFields'
import { BuildReviewAgentFields } from './BuildReviewAgentFields'
import { BuildReviewReviewerSettings, type ReviewerSeat } from './BuildReviewReviewerSettings'
import { BuildReviewSetupRow } from './BuildReviewSetupRow'
import { WorkflowGuideCard } from '../local-workflows/WorkflowGuideCard'
import { WorkflowRunOnPicker } from '../workflow-graph/WorkflowRunsOnSelect'
import { ReviewRubricSelect } from './ReviewRubricPicker'
import { plainFailureText } from './build-review-plain-text'
import { useBuildReviewDraft } from './use-build-review-draft'
import { usableAgentChoice } from './build-review-usable-choice'
import type { BuildReviewDraft } from '../../../../shared/build-review-draft'
import {
  reconcileReviewerSeats,
  reviewerSeatProblem,
  type ReviewerHostCatalog
} from './build-review-seat-host-pinning'

/** A seat added without a rubric reviews against the first seat's, so a panel keeps one purpose. */
function withPanelRubric(seats: ReviewerSeat[]): ReviewerSeat[] {
  const rubric = seats.find((seat) => seat.choice.rubric)?.choice.rubric
  return rubric
    ? seats.map((seat) =>
        seat.choice.rubric ? seat : { ...seat, choice: { ...seat.choice, rubric } }
      )
    : seats
}

function cleanChoice(choice: BuildReviewAgentChoice): BuildReviewAgentChoice {
  return {
    agent: choice.agent,
    ...(choice.model?.trim() ? { model: choice.model.trim() } : {}),
    ...(choice.effort?.trim() ? { effort: choice.effort.trim() } : {})
  }
}

/**
 * Build + Review setup: the objective first, then who builds and who reviews, then the rarely
 * used settings folded under Advanced. A conversation tab already belongs to one workspace, so
 * only the standalone dialog asks for one (`pickWorktree`).
 */
export function BuildReviewStartForm({
  initialWorktree,
  initialObjective = '',
  initialDraft,
  onDraftChange,
  pickWorktree = false,
  pending,
  setPending,
  onStart,
  onCancel
}: {
  initialWorktree?: string
  initialObjective?: string
  initialDraft?: BuildReviewDraft
  onDraftChange?: (draft: BuildReviewDraft) => void
  /** Show the workspace picker; a conversation tab leaves it out because its workspace is fixed. */
  pickWorktree?: boolean
  pending: boolean
  setPending: (pending: boolean) => void
  /** `worktreeId` is the workspace picked in the dialog; a conversation tab passes none. */
  onStart: (request: BuildReviewStartRequest, worktreeId?: string) => Promise<unknown>
  onCancel: () => void
}) {
  const worktrees = useAllWorktrees()
  const folders = useAppStore((s) => s.folderWorkspaces)
  const {
    worktree,
    setWorktree,
    objective,
    setObjective,
    reviewFocus,
    setReviewFocus,
    hubTaskId,
    setHubTaskId,
    builder,
    setBuilder,
    reviewers,
    setReviewers,
    maxReviewRounds,
    setMaxReviewRounds,
    runOn,
    setRunOn
  } = useBuildReviewDraft(
    initialWorktree ?? '',
    initialObjective,
    initialDraft,
    onDraftChange,
    !pickWorktree
  )
  const [error, setError] = useState<string | null>(null)
  const options = [...worktrees, ...folders.map(folderWorkspaceToWorktree)].map((w) => ({
    id: w.id,
    label: w.displayName || w.branch || w.path
  }))
  const selector = toRuntimeWorktreeSelector(worktree)
  // Why 'build-review': an agent whose usage reading is old stays selectable while the setup
  // asks the host for a real one; a reading that rules it out still hides it.
  const capabilities = useWorkAgentCapabilities(
    selector.startsWith('id:') ? selector.slice(3) : selector,
    undefined,
    'build-review'
  )
  const usableAgents = capabilities.usable
  // The selected host's own answer, from the one discovery every launch surface shares.
  const host: ReviewerHostCatalog = { agents: usableAgents, loading: capabilities.loading }
  // Why derived and never stored: a seat pinned into state would freeze at whatever the host
  // said when it was added, so a seat proposed during an outage would never repair itself.
  // Why derived too: "Agent default" or a model whose own usage window is spent would start a
  // run that fails at once ("out of usage credits"); the next usable model runs instead.
  const usableBuilder = usableAgentChoice(builder, usableAgents)
  const pinnedReviewers = reconcileReviewerSeats(reviewers, host, usableBuilder)
  const seatProblem = reviewerSeatProblem(pinnedReviewers, host, usableBuilder)
  const validRounds =
    Number.isInteger(maxReviewRounds) &&
    maxReviewRounds >= 1 &&
    maxReviewRounds <= BUILD_REVIEW_MAX_ROUNDS
  const validWorktree = options.some((w) => toRuntimeWorktreeSelector(w.id) === selector)
  const validHubTaskId = !hubTaskId.trim() || HUB_TASK_ID_PATTERN.test(hubTaskId.trim())
  const blocked =
    pending ||
    !objective.trim() ||
    !validWorktree ||
    !validRounds ||
    !validHubTaskId ||
    Boolean(seatProblem)
  return (
    <form
      className="space-y-5"
      onSubmit={async (event) => {
        event.preventDefault()
        if (blocked) {
          return
        }
        setPending(true)
        setError(null)
        try {
          const request: BuildReviewStartRequest = {
            worktree: selector,
            objective: objective.trim(),
            builder: cleanChoice(usableBuilder),
            reviewers: pinnedReviewers.map((seat) => ({
              ...cleanChoice(seat.choice),
              ...(seat.choice.rubric ? { rubric: seat.choice.rubric } : {})
            })),
            maxReviewRounds,
            // Always sent, like the CLI: the host must never infer fleet from silence.
            ...runOn,
            ...(reviewFocus.trim() ? { reviewFocus: reviewFocus.trim() } : {}),
            ...(hubTaskId.trim() ? { hubTaskId: hubTaskId.trim() } : {})
          }
          const picked = options.find((w) => toRuntimeWorktreeSelector(w.id) === selector)?.id
          await (pickWorktree ? onStart(request, picked) : onStart(request))
        } catch (error) {
          setError(plainFailureText(error instanceof Error ? error.message : String(error)))
        } finally {
          setPending(false)
        }
      }}
    >
      <WorkflowGuideCard kind="build-review" />
      <fieldset disabled={pending} className="space-y-5">
        <div className="space-y-2">
          <Label htmlFor="build-review-objective" className="text-sm font-medium">
            {translate(
              'auto.components.build-review.BuildReviewStartDialog.objective',
              'Objective'
            )}
          </Label>
          <Textarea
            id="build-review-objective"
            autoFocus
            placeholder={translate(
              'buildReview.objectivePlaceholder',
              'Describe the result you want, expected behavior, and what must pass. Example: add search with keyboard navigation and tests.'
            )}
            required
            value={objective}
            onChange={(e) => setObjective(e.target.value)}
            rows={4}
            className="min-h-24 text-sm"
          />
        </div>
        {pickWorktree && (
          <div className="space-y-2">
            <Label htmlFor="build-review-worktree">
              {translate(
                'auto.components.build-review.BuildReviewStartDialog.worktree',
                'Worktree or folder'
              )}
            </Label>
            <Select value={selector} onValueChange={setWorktree}>
              <SelectTrigger id="build-review-worktree" className="w-full">
                <SelectValue
                  placeholder={translate(
                    'auto.components.build-review.BuildReviewStartDialog.choose',
                    'Choose a workspace'
                  )}
                />
              </SelectTrigger>
              <SelectContent>
                {options.map((w) => (
                  <SelectItem key={w.id} value={toRuntimeWorktreeSelector(w.id)}>
                    {w.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        {!pickWorktree && !validWorktree && (
          <p role="alert" className="text-sm text-destructive">
            {translate(
              'buildReview.form.workspaceUnavailableLocalOrSsh',
              'This workspace is not available for Build + Review. Start it from a local or SSH worktree or folder.'
            )}
          </p>
        )}
        {/* Why rows under one muted rule: the Council and Discover composers draw their
            settings this way; framed fieldsets made the setup read as a different product. */}
        <div className="space-y-4 border-t pt-5">
          <BuildReviewAgentFields
            role="builder"
            label={translate(
              'auto.components.build-review.BuildReviewStartDialog.builder',
              'Builder'
            )}
            worktree={selector}
            choice={usableBuilder}
            onChange={setBuilder}
            helpText={null}
            capabilityMode="build-review"
            appearance="row"
          />
          <BuildReviewSetupRow
            label={translate('buildReview.rubric.all', 'Rubric for all')}
            htmlFor="build-review-rubric-all"
          >
            <ReviewRubricSelect
              id="build-review-rubric-all"
              label={translate('buildReview.rubric.all', 'Rubric for all')}
              rubric={pinnedReviewers[0]?.choice.rubric}
              onChange={(rubric) =>
                setReviewers(
                  reviewers.map((seat) => ({ ...seat, choice: { ...seat.choice, rubric } }))
                )
              }
            />
          </BuildReviewSetupRow>
          <BuildReviewReviewerSettings
            compact
            worktree={selector}
            capabilityMode="build-review"
            seats={pinnedReviewers}
            onChange={(seats) => setReviewers(withPanelRubric(seats))}
            rubrics
            nextSeat={(seats) =>
              nextReviewerSeat(usableAgents, [
                builder,
                ...seats.map((seat) => seat.choice)
              ] as NextStepActor[])
            }
            maxRounds={maxReviewRounds}
            onRoundsChange={setMaxReviewRounds}
          />
          {seatProblem && (
            <p role="alert" className="text-sm text-destructive">
              {seatProblem}
            </p>
          )}
          {!seatProblem && pinnedReviewers.length < reviewers.length && (
            <p className="text-xs text-muted-foreground">
              {translate(
                'buildReview.reviewers.fewerModels',
                'Only {{count}} reviewer(s) here can be shown not to be the builder’s own model. Choose the builder’s model to seat more.',
                { count: pinnedReviewers.length }
              )}
            </p>
          )}
          <BuildReviewSetupRow
            htmlFor="build-review-focus"
            label={translate(
              'auto.components.build-review.BuildReviewStartDialog.focus',
              'Review focus (optional)'
            )}
          >
            <Textarea
              id="build-review-focus"
              placeholder={translate(
                'buildReview.focusPlaceholder',
                'Tell reviewers what to check. Example: correctness, security, edge cases, accessibility, and passing tests. Leave blank for a general review.'
              )}
              value={reviewFocus}
              onChange={(e) => setReviewFocus(e.target.value)}
              rows={2}
            />
          </BuildReviewSetupRow>
          <BuildReviewSetupRow
            labelId="build-review-runs-on-label"
            label={translate('buildReview.runsOn', 'Run on')}
          >
            <WorkflowRunOnPicker className="w-56" choice={runOn} onChange={setRunOn} />
          </BuildReviewSetupRow>
        </div>
        <BuildReviewAdvancedFields
          taskId={hubTaskId}
          onTaskIdChange={setHubTaskId}
          taskIdValid={validHubTaskId}
        />
      </fieldset>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="ghost" disabled={pending} onClick={onCancel}>
          {translate('auto.components.build-review.BuildReviewStartDialog.cancel', 'Cancel')}
        </Button>
        <Button type="submit" disabled={blocked}>
          {translate(
            'auto.components.build-review.BuildReviewStartDialog.start',
            'Start Build + Review'
          )}
        </Button>
      </DialogFooter>
    </form>
  )
}
