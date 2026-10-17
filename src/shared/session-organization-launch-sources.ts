/** Where a recorded `launch` filing came from (session-organization-change.ts). */
export const ORGANIZATION_LAUNCH_SOURCES = [
  'session-prep',
  'terminal-create',
  'session-launch',
  /** A worker sent into a project with `worker-start --project` (backend plan §2b). */
  'worker-start',
  /** A routine run filed into its project (upgrade plan PR 12). */
  'routine'
] as const
