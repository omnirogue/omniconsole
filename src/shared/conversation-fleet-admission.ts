import {
  CONVERSATION_PERSON_HANDOFF_ACTOR,
  conversationPersonHandoff
} from './console-conversation-person-handoff'
import type { ConsoleWorkflowAdmission, ConsoleWorkflowJob } from './console-workflow-types'

function admittedJob(job: ConsoleWorkflowJob, workflowId: string): boolean {
  const workflow = job.policy.workflow
  if (!job.id || workflow.dispatch_id !== workflowId) {
    return false
  }
  if (job.actor_type === 'ai') {
    return (workflow.placement ?? 'fleet') === 'fleet'
  }
  return (
    job.actor_type === 'mechanical' &&
    workflow.actor_id === CONVERSATION_PERSON_HANDOFF_ACTOR &&
    workflow.action === 'notify' &&
    job.provider == null &&
    job.model == null &&
    job.machine == null &&
    conversationPersonHandoff.safeParse(workflow.person_handoff).success
  )
}

/** A delivery receipt admits a person handoff; it does not prove a human decision or completion. */
export function isConversationFleetAdmission(receipt: ConsoleWorkflowAdmission): boolean {
  return Boolean(
    receipt.workflow_id &&
    receipt.jobs.length &&
    new Set(receipt.jobs.map((job) => job.id)).size === receipt.jobs.length &&
    receipt.jobs.every((job) => admittedJob(job, receipt.workflow_id))
  )
}
