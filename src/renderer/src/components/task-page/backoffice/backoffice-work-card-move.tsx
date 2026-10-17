import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import {
  consoleWorkflowApi,
  workflowData,
  workflowErrorMessage
} from '@/lib/console-workflow-client'
import { finishNextStep } from '@/components/next-step/next-step-actions'
import type { BackofficeTodoItem } from '../../../../../shared/backoffice-work-types'
import type { WorkCard } from '../../../../../shared/console-work-home-contract'
import { isProposedTask, withProposed } from '../../../../../shared/proposed-task'
import { taskStanding } from '../../../../../shared/task-state'
import {
  BackofficeMoveDetailsDialog,
  type MoveDetails,
  type MoveDetailsKind
} from './backoffice-move-details-dialog'
import { BackofficeCompletionEvidenceDialog } from './backoffice-completion-evidence-dialog'
import { workKanbanColumns, type WorkColumn } from './work-kanban-presentation'
import {
  classifyMoveRefusal,
  moveIneligibilityHint,
  moveRefusalMessage,
  planWorkCardMove,
  type WorkCardMovePlan
} from './work-kanban-move'

type FreshCard = { revision: number; tags: string[] }

/**
 * The card as the hub holds it now. A tag write replaces the whole list, so the list it
 * starts from must be this read, never the board projection (which may be seconds old or,
 * from an older console, carry no tags at all).
 */
async function readCard(taskId: string): Promise<FreshCard> {
  const card = workflowData(await consoleWorkflowApi().getTask({ taskId }))
  if (typeof card.state_revision !== 'number') {
    throw new Error(
      translate('workKanban.moveNoRevision', 'This task did not report a revision to move from.')
    )
  }
  return { revision: card.state_revision, tags: card.tags ?? [] }
}

/**
 * "Move to…" on one Kanban card: the other columns, each as the hub's own lifecycle
 * verb. Proposed is a tag change on the same reviewed PATCH. Done is listed too but never
 * sent as a verb — it runs the existing completion path so the hub's evidence gate still
 * answers.
 */
export function BackofficeWorkCardMove({
  card,
  column,
  todo,
  onMoved,
  onPending
}: {
  card: WorkCard
  column: WorkColumn
  /** This person's row for the card, when they have one; it carries the revision. */
  todo: BackofficeTodoItem | null
  onMoved: (taskId: string, target: WorkColumn) => void | Promise<void>
  onPending?: (pending: boolean) => void
}): React.JSX.Element {
  const moving = useRef(false)
  const [detailsTarget, setDetailsTarget] = useState<{
    column: WorkColumn
    kind: MoveDetailsKind
  } | null>(null)
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [evidence, setEvidence] = useState<BackofficeTodoItem | null>(null)

  // Why no exception for proposals: a card the hub calls ineligible was filed outside this
  // app; accepting it here would drop it off this board while it lives on in the console.
  if (card.kanban_eligible !== true) {
    return (
      <p className="text-[11px] text-muted-foreground" data-work-card-move-blocked={card.id}>
        {moveIneligibilityHint(card.kanban_reason)}
      </p>
    )
  }

  const refuse = (error: unknown): void => {
    const text = moveRefusalMessage(classifyMoveRefusal(error), workflowErrorMessage(error))
    setMessage(text)
    toast.error(text)
  }

  const writeTags = async (tags: string[], expectedRevision: number): Promise<void> => {
    workflowData(await consoleWorkflowApi().updateTask({ taskId: card.id, expectedRevision, tags }))
  }

  /**
   * One attempt at the whole move. A tag change always starts from a fresh read (the list it
   * writes must be the hub's, not the projection's); a plain verb trusts the row's revision
   * unless this is the retry after a stale answer. A refused verb puts the tag back.
   */
  const send = async (
    plan: WorkCardMovePlan,
    retry: boolean,
    details: MoveDetails
  ): Promise<void> => {
    const fresh =
      plan.setProposed !== undefined || retry || todo?.state_revision == null
        ? await readCard(card.id)
        : { revision: todo.state_revision, tags: card.tags ?? [] }
    let revision = fresh.revision
    if (plan.setProposed !== undefined) {
      await writeTags(withProposed(fresh.tags, plan.setProposed), revision)
      if (!plan.action) {
        return
      }
    }
    if (!plan.action) {
      return
    }
    try {
      if (plan.setProposed !== undefined) {
        revision = (await readCard(card.id)).revision
      }
      workflowData(
        await consoleWorkflowApi().transitionTask({
          taskId: card.id,
          action: plan.action,
          expectedRevision: revision,
          ...details
        })
      )
    } catch (error) {
      if (plan.setProposed === undefined) {
        throw error
      }
      // Why restore: half a move is worse than none — the card would have left Proposed
      // while the hub refused the lane it was headed for.
      try {
        const latest = await readCard(card.id)
        await writeTags(withProposed(latest.tags, isProposedTask(fresh.tags)), latest.revision)
      } catch {
        throw new Error(
          translate(
            'workKanban.moveRecoveryFailed',
            'The Proposed tag changed, but the move could not be completed: {{reason}}. Restoring the tag also failed. Refresh the board and use Move to… to recover.',
            { reason: workflowErrorMessage(error) }
          )
        )
      }
      throw error
    }
  }

  const move = async (to: WorkColumn, details: MoveDetails = {}): Promise<void> => {
    const plan = planWorkCardMove(
      column,
      to,
      taskStanding({
        status: card.status,
        kanbanStatus: card.kanban_status,
        triageState: card.triage_state,
        deferUntil: card.defer_until,
        pausedAt: card.paused_at,
        verifiedAt: card.verified_at,
        verificationFailedAt: card.verification_failed_at
      }).state
    )
    if (!plan || moving.current) {
      return
    }
    const kind =
      plan.action === 'wait'
        ? 'wait'
        : plan.action === 'resume'
          ? 'resume'
          : plan.action === 'submit_for_review'
            ? 'review'
            : null
    if (kind && !details.reason && !details.resultRef) {
      setMessage(null)
      setDetailsTarget({ column: to, kind })
      return
    }
    moving.current = true
    setPending(true)
    onPending?.(true)
    setMessage(null)
    try {
      try {
        await send(plan, false, details)
      } catch (error) {
        if (classifyMoveRefusal(error) !== 'stale-revision') {
          throw error
        }
        // Why retry once from a fresh read: a second conflict is a real disagreement,
        // not a race worth hiding.
        await send(plan, true, details)
      }
      await onMoved(card.id, to)
      setDetailsTarget(null)
    } catch (error) {
      refuse(error)
    } finally {
      moving.current = false
      setPending(false)
      onPending?.(false)
    }
  }

  const complete = async (resultRef?: string): Promise<void> => {
    if (!todo) {
      setMessage(translate('workKanban.moveNoCard', 'Open the task to finish it.'))
      return
    }
    moving.current = true
    setPending(true)
    onPending?.(true)
    setMessage(null)
    try {
      const result = await finishNextStep({ kind: 'card', item: todo }, todo, resultRef)
      if (result.ok) {
        setEvidence(null)
        toast.success(result.message)
        await onMoved(card.id, 'done')
      } else if (result.evidenceItem) {
        setEvidence(result.evidenceItem)
      } else {
        setMessage(result.message)
        toast.error(result.message)
      }
    } catch (error) {
      refuse(error)
    } finally {
      moving.current = false
      setPending(false)
      onPending?.(false)
    }
  }

  const label = translate('workKanban.moveTo', 'Move to…')
  return (
    <div className="space-y-1">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            data-work-card-move={card.id}
            aria-label={translate('workKanban.moveCard', 'Move {{value0}}', { value0: card.title })}
          >
            {pending ? translate('workKanban.moving', 'Moving…') : label}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {workKanbanColumns()
            .filter((target) => target.state !== column)
            .map((target) => (
              <DropdownMenuItem
                key={target.state}
                data-work-card-move-target={target.state}
                onSelect={() => void (target.state === 'done' ? complete() : move(target.state))}
              >
                {target.label}
              </DropdownMenuItem>
            ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {detailsTarget && (
        <BackofficeMoveDetailsDialog
          kind={detailsTarget.kind}
          title={card.title}
          pending={pending}
          error={message}
          onSubmit={(details) => void move(detailsTarget.column, details)}
          onDismiss={() => !pending && setDetailsTarget(null)}
        />
      )}
      {message && !detailsTarget && (
        <p
          role="alert"
          className="text-[11px] text-destructive"
          data-work-card-move-error={card.id}
        >
          {message}
        </p>
      )}
      {evidence && (
        <BackofficeCompletionEvidenceDialog
          item={evidence}
          pending={pending}
          onSubmit={(resultRef) => void complete(resultRef)}
          onDismiss={() => !pending && setEvidence(null)}
        />
      )}
    </div>
  )
}
