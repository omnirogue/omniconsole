import { useMemo, useSyncExternalStore } from 'react'

// Pull requests the person approved from a session card. It records the person's own "yes" on
// this computer only: nothing is sent to GitHub, the hub or Jira.

const STORAGE_KEY = 'omni.sessionProgress.approved.v1'
/** Old approvals age out; a card only ever needs the recent ones. */
const MAX_APPROVALS = 300

let approved: string[] | null = null
const listeners = new Set<() => void>()
let revision = 0

function load(): string[] {
  if (approved) {
    return approved
  }
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '[]')
    approved = Array.isArray(parsed) ? parsed.filter((key) => typeof key === 'string') : []
  } catch {
    approved = []
  }
  return approved
}

function save(next: string[]): void {
  approved = next.slice(-MAX_APPROVALS)
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(approved))
  } catch {
    // Why: storage can be unavailable; the approval still holds for this run of the app.
  }
  revision += 1
  for (const listener of listeners) {
    listener()
  }
}

/** Marks these pull requests (keys `owner/repo#n`) approved by the person. */
export function approveSessionPullRequests(keys: readonly string[]): void {
  const current = load()
  save([...current.filter((key) => !keys.includes(key)), ...keys])
}

export function withdrawSessionPullRequestApproval(keys: readonly string[]): void {
  save(load().filter((key) => !keys.includes(key)))
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function currentRevision(): number {
  return revision
}

export function useApprovedSessionPullRequests(): ReadonlySet<string> {
  const seen = useSyncExternalStore(subscribe, currentRevision)
  return useMemo(() => {
    void seen
    return new Set(load())
  }, [seen])
}

export function resetSessionApprovalsForTest(): void {
  approved = null
  revision = 0
}
