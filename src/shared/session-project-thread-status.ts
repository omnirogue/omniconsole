/**
 * Where a project's thread stands (docs/plans/projects-backend.md §3): the sidebar's folder tally
 * states with `done` split into Ready for review and Completed. The renderer derives it
 * (`sessionProjectThreadStatus`); `omni session list --project` carries it as `projectStatus`.
 */
export const SESSION_PROJECT_THREAD_STATUSES = [
  'working',
  'needsYou',
  'reviewReady',
  'waiting',
  'stopped',
  'cantSee',
  'done'
] as const

export type SessionProjectThreadStatus = (typeof SESSION_PROJECT_THREAD_STATUSES)[number]
