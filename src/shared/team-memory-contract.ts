import { z } from 'zod'

/**
 * `GET /api/team-memory/status` — whether the instructions Sal and Uma wrote
 * ("team memory", for everyone and for this employee) are loaded into the
 * connector this person's agents talk to. The IDE shows it in the status bar
 * so a silently missing memory is visible instead of assumed.
 */
const memoryRevision = z
  .object({
    revision: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative().optional(),
    updated_at: z.string().nullable().optional()
  })
  .passthrough()

export const teamMemoryStatus = z
  .object({
    employee_id: z.string().nullable().optional(),
    rendered_bytes: z.number().int().nonnegative().optional(),
    index_over_budget: z.boolean().optional(),
    // Earlier shape of the same fact; accepted so a console one release behind still reads.
    index: z.object({ over_budget: z.boolean().optional() }).passthrough().optional(),
    everyone: memoryRevision.nullable().optional(),
    personal: memoryRevision.nullable().optional(),
    loaded_in_connector: z.boolean()
  })
  .passthrough()
export type TeamMemoryStatus = z.infer<typeof teamMemoryStatus>

export const TEAM_MEMORY_NOT_LOADED_REASONS = [
  'not_signed_in',
  'no_employee_mapping',
  'request_failed',
  'not_loaded'
] as const
export type TeamMemoryNotLoadedReason = (typeof TEAM_MEMORY_NOT_LOADED_REASONS)[number]

/** What main keeps and the renderer shows. `checkedAt` is epoch ms of the last check. */
export type TeamMemoryStatusView =
  | {
      state: 'loaded'
      everyoneRevision: number | null
      personalRevision: number | null
      /** The connector's knowledge index is above budget: memory loads clipped. */
      indexOverBudget: boolean
      checkedAt: number
    }
  | { state: 'not_loaded'; reason: TeamMemoryNotLoadedReason; checkedAt: number }
  | { state: 'unknown' }

export type TeamMemoryApi = {
  status: () => Promise<TeamMemoryStatusView>
  refresh: () => Promise<TeamMemoryStatusView>
  onStatus: (callback: (status: TeamMemoryStatusView) => void) => () => void
}

/** The transport's refusal codes that mean "not signed in" versus "no employee". */
export function teamMemoryReasonForError(code: string): TeamMemoryNotLoadedReason {
  if (code === 'signed_in_required' || code === 'backoffice_unconfigured') {
    return 'not_signed_in'
  }
  if (code === 'no-employee-mapping' || code === 'no_employee_mapping') {
    return 'no_employee_mapping'
  }
  return 'request_failed'
}

export function teamMemoryViewFromStatus(
  status: TeamMemoryStatus,
  checkedAt: number
): TeamMemoryStatusView {
  // Absent, null or empty all mean the console could not map this person to an employee.
  if (!status.employee_id) {
    return { state: 'not_loaded', reason: 'no_employee_mapping', checkedAt }
  }
  if (!status.loaded_in_connector) {
    return { state: 'not_loaded', reason: 'not_loaded', checkedAt }
  }
  return {
    state: 'loaded',
    everyoneRevision: status.everyone?.revision ?? null,
    personalRevision: status.personal?.revision ?? null,
    indexOverBudget: status.index_over_budget ?? status.index?.over_budget ?? false,
    checkedAt
  }
}
