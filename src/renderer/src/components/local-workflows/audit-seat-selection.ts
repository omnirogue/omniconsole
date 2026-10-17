import type {
  LocalWorkflowSeatCatalog,
  LocalWorkflowSeatChoice
} from '../../../../shared/local-workflow-seats'

/** API-backed routes require an explicit selection in a new Audit. */
export function defaultAuditSeats(
  team: readonly LocalWorkflowSeatChoice[],
  catalog: readonly LocalWorkflowSeatCatalog[]
): readonly LocalWorkflowSeatChoice[] {
  for (const model of ['gpt-6-luna', 'gpt-5.6-luna']) {
    const seat = team.find(
      (candidate) =>
        candidate.agent === 'codex' &&
        catalog.some(
          (entry) =>
            entry.agent === 'codex' &&
            entry.accountId === candidate.accountId &&
            !entry.unavailableReason &&
            entry.models.some((option) => option.catalog.id === model)
        )
    )
    if (seat) {
      return [{ ...seat, model, effort: undefined }]
    }
  }
  return []
}
