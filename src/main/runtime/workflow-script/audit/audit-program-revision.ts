export const AUDIT_PROGRAM_REVISION = 5
export type AuditProgramRevision = 1 | 2 | 3 | 4 | 5

export function isSupportedAuditRevision(value: unknown): value is AuditProgramRevision {
  return value === 1 || value === 2 || value === 3 || value === 4 || value === 5
}
