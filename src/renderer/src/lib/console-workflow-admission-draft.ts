import { taskAdmissionContext } from '../../../shared/console-workflow-task-admission-schemas'
import type { ConsoleTaskAdmissionContext } from '../../../shared/console-workflow-task-types'

export type WorkflowAdmissionDraft = {
  goalId: string
  title: string
  desiredResult: string
  acceptancePolicy: string
  verificationPolicy: string
  orgUnitId: string
  authorityEpoch: string
  adoptStage: string
}

export function newWorkflowAdmissionDraft(): WorkflowAdmissionDraft {
  return {
    goalId: '',
    title: '',
    desiredResult: '',
    acceptancePolicy: '',
    verificationPolicy: '',
    orgUnitId: '',
    authorityEpoch: '',
    adoptStage: ''
  }
}

function policy(value: string, label: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    throw new Error(`${label} must be a nonempty JSON object.`)
  }
}

export function workflowAdmissionContext(
  draft: WorkflowAdmissionDraft
): ConsoleTaskAdmissionContext {
  if (!/^\d+$/.test(draft.authorityEpoch.trim())) {
    throw new Error('Enter the current authority epoch from the task authority.')
  }
  const parsed = taskAdmissionContext.safeParse({
    objective: {
      goal_id: draft.goalId,
      title: draft.title,
      desired_result: draft.desiredResult,
      acceptance_policy: policy(draft.acceptancePolicy, 'Acceptance policy'),
      verification_policy: policy(draft.verificationPolicy, 'Verification policy')
    },
    orgUnitId: draft.orgUnitId,
    expectedAuthorityEpoch: Number(draft.authorityEpoch),
    adoptStage: draft.adoptStage
  })
  if (!parsed.success) {
    throw new Error(
      'Provide the objective, nonempty policies, organization, current authority epoch and adopted stage.'
    )
  }
  return parsed.data
}
