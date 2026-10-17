/** App features the window may record under (session-organization-change.ts); not the steward. */
export const ORGANIZATION_WIRE_APP_FEATURES = [
  'auto-archive',
  'key-migration',
  'transfer',
  'finish',
  'restore'
] as const
/**
 * `steward`: main's own unattended changes (Phase 2, D4); `archive-sleep`: an archive that put an
 * idle agent to sleep (`sessionOrganization.noteArchiveSleep`); `artifact-review`: a review page's
 * decision; `answer-delivery`: an answer restoring its conversation. Only main records any of them.
 */
export const ORGANIZATION_APP_FEATURES = [
  ...ORGANIZATION_WIRE_APP_FEATURES,
  'steward',
  'archive-sleep',
  // A decision on a review page this desktop published (Reject deletes, a close archives).
  'artifact-review',
  // A reply on the owner's work (a Jira QA comment) reopened an archived session.
  'work-delivery',
  // An answered decision or question brought its deleted or hidden conversation back.
  'answer-delivery'
] as const
