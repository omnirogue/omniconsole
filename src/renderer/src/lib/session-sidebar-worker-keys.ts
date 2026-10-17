/** Folds of workers start closed: a launcher's workers, and the Agent sessions group. */
export const SESSION_WORKERS_KEY_PREFIX = 'workers:'

/** The Agent sessions group: workers whose launcher is gone (session-sidebar-worker-rows). */
export const SESSION_WORKERS_GROUP_KEY = `${SESSION_WORKERS_KEY_PREFIX}agent-sessions`

/** The fold of a session's workers, kept with the groups' folds; workers start folded. */
export function sessionWorkersKey(viewKey: string): string {
  return `${SESSION_WORKERS_KEY_PREFIX}${viewKey}`
}
