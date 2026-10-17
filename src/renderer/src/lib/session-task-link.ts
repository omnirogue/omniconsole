import { z } from 'zod'
import { consoleJiraWorkRef } from '../../../shared/console-jira-work-contract'
import { jiraTaskId, jiraSessionTaskId } from '../../../shared/console-jira-session-contract'
import { taskSessionId } from '../../../shared/console-session-task-binding'

/**
 * Which task each conversation serves, remembered on this device. The server's task binding is the
 * truth; this is the cache that lets the row draw its
 * state without a round trip, and the record of the canonical session id
 * confirmed for that conversation.
 */
export const SESSION_TASK_STORAGE_KEY = 'omni.session-tasks.v1'

const link = z
  .object({
    taskId: z.union([z.string().regex(/^btk_[A-Za-z0-9]{4,64}$/), jiraTaskId]),
    workRef: consoleJiraWorkRef.optional(),
    accountScope: z.string().optional(),
    /** The server-confirmed hub or canonical ledger session for this conversation. */
    sessionId: taskSessionId.optional(),
    title: z.string().max(500).optional(),
    at: z.string().max(40).optional()
  })
  .strict()
  .refine(
    (value) =>
      !value.taskId.startsWith('jira:') ||
      Boolean(
        value.workRef && value.accountScope && jiraSessionTaskId(value.workRef) === value.taskId
      )
  )

const links = z.record(z.string().min(1).max(400), link)

export type SessionTaskLink = z.infer<typeof link>
export type SessionTaskLinks = Record<string, SessionTaskLink>

export function emptySessionTaskLinks(): SessionTaskLinks {
  return {}
}

/** A stored map that has drifted (an older build, a hand edit) reads as empty, never throws. */
export function parseSessionTaskLinks(value: unknown): SessionTaskLinks {
  const parsed = links.safeParse(value)
  if (parsed.success) {
    return parsed.data
  }
  if (!value || typeof value !== 'object') {
    return {}
  }
  // Why: one bad row must not lose every other link.
  const kept: SessionTaskLinks = {}
  for (const [key, row] of Object.entries(value as Record<string, unknown>)) {
    const one = link.safeParse(row)
    if (one.success && key.trim()) {
      kept[key] = one.data
    }
  }
  return kept
}

export function setSessionTaskLink(
  current: SessionTaskLinks,
  paneKey: string,
  next: SessionTaskLink | null
): SessionTaskLinks {
  const key = paneKey.trim()
  if (!key) {
    return current
  }
  if (next === null) {
    if (!(key in current)) {
      return current
    }
    const { [key]: _removed, ...rest } = current
    return rest
  }
  return { ...current, [key]: next }
}

/** Every conversation on this device that serves one task. */
export function paneKeysForTask(current: SessionTaskLinks, taskId: string): string[] {
  return Object.entries(current)
    .filter(([, row]) => row.taskId === taskId)
    .map(([key]) => key)
}
