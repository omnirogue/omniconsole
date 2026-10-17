import { z } from 'zod'
// Value re-export for the client's runtime request() call; only used at type position in this file.
export { teamRoutineRuns } from './console-routine-conversation-contract'
import type { teamRoutineRuns } from './console-routine-conversation-contract'
import type { ConsoleWorkflowResult } from './console-workflow-types'

// The snapshots only specify string IDs. Bound path segments defensively until the hub publishes a pattern.
export const teamRoutineId = z.string().regex(/^rtn_[A-Za-z0-9_]{1,128}$/)
export const teamRoutineRequest = z.object({ id: teamRoutineId }).strict()
export const teamRoutineShareRequest = teamRoutineRequest.extend({
  employeeId: z.string().regex(/^emp_[A-Za-z0-9_]{1,128}$/)
})

// Access shape read from omniagentos/api/routes/routines.py _serialize_routine (~261-312) and
// omniagentos/scheduler/routine_collaboration.py snapshot (~319-350) — undocumented in the
// checked-in OpenAPI snapshot, which types the routine as a free-form object.
const pendingHandoff = z
  .object({
    thread_id: z.string().nullish(),
    decision_id: z.string().nullish(),
    from_employee_id: z.string().nullish(),
    to_employee_id: z.string().nullish(),
    created_at: z.string().nullish()
  })
  .nullish()

export const teamRoutine = z
  .object({
    id: teamRoutineId.optional(),
    name: z.string().nullish(),
    title: z.string().nullish(),
    status: z.string().nullish(),
    kind: z.string().nullish(),
    trigger_type: z.string().nullish(),
    trigger_config: z.record(z.string(), z.unknown()).nullish(),
    every: z.string().nullish(),
    next_due: z.string().nullish(),
    last_run_at: z.string().nullish(),
    runs: z.number().nullish(),
    source: z.string().nullish(),
    owner_employee_id: z.string().nullish(),
    // Includes the owner; collaborators are members minus owner_employee_id.
    members: z.array(z.string()).catch([]),
    viewer_role: z.enum(['owner', 'collaborator']).nullable().catch(null),
    // False (or absent) means the routine has no access rows yet (legacy): membership is
    // unknown, avatars stay hidden, but the hub still lets the rightful owner self-claim.
    access_canonical: z.boolean().nullish(),
    pending_handoff: pendingHandoff
  })
  .passthrough()
export const teamRoutines = z.array(teamRoutine)
export const teamRoutineShareResponse = teamRoutine
export type TeamRoutine = z.infer<typeof teamRoutine>
export type ConsoleTeamRoutinesApi = {
  list(): Promise<ConsoleWorkflowResult<TeamRoutine[]>>
  get(args: { id: string }): Promise<ConsoleWorkflowResult<TeamRoutine>>
  runs(args: { id: string }): Promise<ConsoleWorkflowResult<z.infer<typeof teamRoutineRuns>>>
  share(args: { id: string; employeeId: string }): Promise<ConsoleWorkflowResult<TeamRoutine>>
  enable(args: { id: string }): Promise<ConsoleWorkflowResult<TeamRoutine>>
  disable(args: { id: string }): Promise<ConsoleWorkflowResult<TeamRoutine>>
  // Local-to-team conversion.
  create(
    args: TeamRoutineCreateRequest
  ): Promise<ConsoleWorkflowResult<TeamRoutine & { id: string }>>
}

// Local-to-team conversion: disabled AI drafts only.
export const teamRoutineCreateRequest = z
  .object({
    name: z.string().trim().min(1),
    description: z.literal(''),
    trigger_type: z.literal('cron'),
    trigger_config: z.object({ cron: z.string().min(1) }).strict(),
    task_template: z.object({ title: z.string().min(1), prompt: z.string().min(1) }).strict(),
    status: z.literal('disabled'),
    scope: z.string().regex(/^[a-z0-9-]+\/[a-z0-9-]+$/),
    purpose: z.literal('ai')
  })
  .strict()
export type TeamRoutineCreateRequest = z.infer<typeof teamRoutineCreateRequest>
export const teamRoutineCreateResponse = teamRoutine.extend({ id: teamRoutineId })
