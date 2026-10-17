import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  WorkflowError,
  WorkflowTextField,
  WorkflowValue
} from '@/components/console-workflows/WorkflowFields'
import { useWorkflowRequest } from '@/components/console-workflows/use-workflow-request'
import {
  consoleWorkflowApi,
  isStaleWorkflowResponse,
  workflowData
} from '@/lib/console-workflow-client'
import { translate } from '@/i18n/i18n'
import type { ConsoleWorkflowJob } from '../../../../../shared/console-workflow-types'
import { useBackofficeWorkFocus } from './backoffice-work-selection'

const NOTE_MAX = 3000

/**
 * A workflow stage assigned to this person: approve, reject or submit completion evidence.
 * Not the shared ✓ — a decision is a different verb with an owner the server names and
 * evidence it requires, so the form is the only control the stage gets.
 */
export function HumanJobDecisionForm({
  job,
  scope,
  onDecided
}: {
  job: ConsoleWorkflowJob
  /** The account scope the row was read under; a focus request is bound to it. */
  scope: string
  /** After the server accepted the decision, and after a stale refusal (the stage changed). */
  onDecided: () => void | Promise<void>
}): React.JSX.Element {
  const [note, setNote] = useState('')
  const [evidence, setEvidence] = useState('')
  const request = useWorkflowRequest()
  const decisionNote = `${note.trim()}\nEvidence: ${evidence.trim()}`
  const canSubmit =
    job.can_decide === true &&
    evidence.trim().length > 0 &&
    decisionNote.length <= NOTE_MAX &&
    !request.pending
  const decide = (decision: 'approve' | 'reject' | 'complete') =>
    void request.run(async () => {
      if (!canSubmit) {
        return
      }
      try {
        workflowData(
          await consoleWorkflowApi().decideHumanAction({
            jobId: job.id,
            decision,
            note: decisionNote
          })
        )
        await onDecided()
      } catch (error) {
        if (isStaleWorkflowResponse(error)) {
          await onDecided()
        }
        throw error
      }
    })
  return (
    <section className="space-y-3" data-work-decision={job.id}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{job.title}</h3>
        <Badge variant="outline">{job.workflow_state}</Badge>
      </div>
      <dl className="space-y-2">
        <WorkflowValue
          label={translate('consoleWorkflows.assignedTo', 'Assigned to')}
          value={job.policy.workflow.actor_id}
        />
        <WorkflowValue
          label={translate('consoleWorkflows.blockers', 'Blockers')}
          value={job.blockers.length ? job.blockers : null}
        />
      </dl>
      {/* Why: the stage's card row carries the Run section (stages, blockers, machine); focus it, never a second page. */}
      <Button
        size="sm"
        variant="link"
        onClick={() => useBackofficeWorkFocus.getState().focus({ scope, taskId: job.task_id })}
      >
        {translate('backofficeWork.openCard', 'Open card')}
      </Button>
      {job.can_decide ? (
        <>
          <WorkflowTextField
            label={translate('consoleWorkflows.decisionNote', 'Decision note')}
            value={note}
            onChange={setNote}
            disabled={request.pending}
            multiline
            maxLength={NOTE_MAX}
          />
          <WorkflowTextField
            label={translate('consoleWorkflows.evidence', 'Evidence reference or result')}
            value={evidence}
            onChange={setEvidence}
            disabled={request.pending}
            multiline
            maxLength={NOTE_MAX}
          />
          {decisionNote.length > NOTE_MAX && (
            <WorkflowError
              message={translate(
                'consoleWorkflows.noteTooLong',
                'The note and evidence together must be at most 3000 characters.'
              )}
            />
          )}
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={!canSubmit}
              onClick={() =>
                decide(job.policy.workflow.action === 'approve' ? 'approve' : 'complete')
              }
            >
              {job.policy.workflow.action === 'approve'
                ? translate('consoleWorkflows.approve', 'Approve')
                : translate('consoleWorkflows.submitEvidence', 'Submit completion evidence')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!canSubmit}
              onClick={() => decide('reject')}
            >
              {translate('consoleWorkflows.reject', 'Reject')}
            </Button>
          </div>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          {translate(
            'consoleWorkflows.decisionUnavailable',
            'The server has not made this job available for your decision.'
          )}
        </p>
      )}
      <WorkflowError message={request.error} />
    </section>
  )
}
