/** Owner sidebar placement, independent of whether the agent process is currently running. */
export type SessionArchiveProjection = { archived: boolean; byHand: boolean }

/** Additive wire field: old hosts omit it, which is unknown rather than unarchived. */
export function readSessionArchiveProjection(value: unknown): SessionArchiveProjection | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const row = value as Record<string, unknown>
  return typeof row.archived === 'boolean' && typeof row.byHand === 'boolean'
    ? { archived: row.archived, byHand: row.byHand }
    : undefined
}
