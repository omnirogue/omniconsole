import { z } from 'zod'
import { WORKFLOW_AGENT_FORCE_HOST_REFUSAL } from './local-workflow-placement'

/**
 * Which workflows an agent may start when a person asks it to. The JEV trials stay closed to
 * agents (their owner's call); every other kind not listed true is started by a person.
 */
export const WORKFLOW_AGENT_LAUNCHABLE = {
  council: true,
  discover: true,
  'build-review': true,
  // Runs jev-lab's evaluator on the fleet; never deploys or sends anything.
  evolve: true,
  custom: false,
  'best-of-n': false,
  improve: false,
  find: false,
  decide: false,
  investigate: false,
  'quick-discover': false,
  advertising_review: false,
  evidence_review: false,
  work_routing: false
} as const satisfies Record<string, boolean>

export type WorkflowAgentLaunchKind = keyof typeof WORKFLOW_AGENT_LAUNCHABLE

export function workflowAgentLaunchable(kind: string): boolean {
  return (WORKFLOW_AGENT_LAUNCHABLE as Record<string, boolean>)[kind] === true
}

export const WORKFLOW_REQUESTED_BY_MAX_CHARS = 200
export const WORKFLOW_REQUEST_MAX_CHARS = 4_000
export const workflowRequestedByIdSchema = z.string().regex(/^emp_[a-z0-9_]{1,64}$/)

/**
 * "Run on: <host>" and who asked, as a workflow draft or a Build + Review Start carries them
 * (docs/reference/workflow-fleet-placement.md); the host resolves and refuses them by name.
 */
export const workflowLaunchChoiceFields = {
  runsOnHost: z.string().trim().min(1).max(253).optional(),
  runsOnHostId: z.string().trim().min(1).max(512).optional(),
  forceHost: z.string().trim().min(1).max(WORKFLOW_REQUEST_MAX_CHARS).optional(),
  requestedBy: z.string().trim().min(1).max(WORKFLOW_REQUESTED_BY_MAX_CHARS).optional(),
  requestedById: workflowRequestedByIdSchema.optional(),
  request: z.string().trim().min(1).max(WORKFLOW_REQUEST_MAX_CHARS).optional()
}

/** Who asked, in their words; frozen with the run and shown wherever the run is. */
export type WorkflowAgentLaunchFields = {
  requestedBy?: string
  requestedById?: string
  request?: string
  forceHost?: string
}

/**
 * Why an agent caller may not start this workflow, or undefined when it may: the kind must be
 * agent-launchable, both the person and their words must be given, and a busy host is never
 * forced by an agent.
 */
export function workflowAgentLaunchRefusal(
  kind: string,
  fields: WorkflowAgentLaunchFields
): string | undefined {
  if (!workflowAgentLaunchable(kind)) {
    return `An agent cannot start ${kind} workflows; a person starts them from the app.`
  }
  if (!fields.requestedBy?.trim() || !fields.request?.trim()) {
    return 'An agent starts a workflow only when a person asks: give --requested-by "<person>" and --request "<their words>".'
  }
  if (fields.forceHost?.trim()) {
    return WORKFLOW_AGENT_FORCE_HOST_REFUSAL
  }
  return undefined
}
