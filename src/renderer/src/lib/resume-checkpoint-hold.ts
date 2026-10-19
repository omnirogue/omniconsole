// `session restart` keeps the checkpoint it relaunched from until main hears from the new pane's
// agent. It is set aside at launch rather than written onto the new pane, so that pane still
// starts by its own fresh spawn, never the cold-restore path.

import { useAppStore } from '@/store'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { makePaneKey } from '../../../shared/stable-pane-id'

const SET_ASIDE_TTL_MS = 10 * 60_000
const setAside = new Map<string, { record: SleepingAgentSessionRecord; at: number }>()

/** The pane a just-launched resume tab starts its agent in. */
export function launchedTabPaneKey(tabId: string | null): string | null {
  const leafId = tabId ? useAppStore.getState().terminalLayoutsByTabId[tabId]?.activeLeafId : null
  return tabId && leafId ? makePaneKey(tabId, leafId) : null
}

export function setAsideResumeCheckpoint(
  tabId: string,
  record: SleepingAgentSessionRecord,
  now = Date.now()
): void {
  for (const [key, entry] of setAside) {
    if (now - entry.at > SET_ASIDE_TTL_MS) {
      setAside.delete(key)
    }
  }
  setAside.set(tabId, { record, at: now })
}

/**
 * No agent hook confirmed the restart, so the conversation must stay resumable. `launched`: no
 * report at all, so it becomes the new pane's own `live` record (the old pane would wake a second
 * copy beside it); a record that pane's agent already wrote wins. `original`: the new pane runs
 * another conversation or cannot be named, so the record goes back where it was.
 */
export function keepResumeCheckpoint(
  tabId: string,
  onto: 'launched' | 'original'
): { kept: boolean } {
  const entry = setAside.get(tabId)
  setAside.delete(tabId)
  const records = useAppStore.getState().sleepingAgentSessionsByPaneKey
  if (!entry) {
    return { kept: false }
  }
  if (onto === 'original') {
    if (records[entry.record.paneKey]) {
      return { kept: false }
    }
    useAppStore.setState((s) => ({
      sleepingAgentSessionsByPaneKey: {
        ...s.sleepingAgentSessionsByPaneKey,
        [entry.record.paneKey]: entry.record
      }
    }))
    return { kept: true }
  }
  const paneKey = launchedTabPaneKey(tabId)
  if (!paneKey || records[paneKey]) {
    return { kept: false }
  }
  const {
    restoreOnTabOpenOnly: _restoreOnTabOpenOnly,
    resumeOnFirstReveal: _resumeOnFirstReveal,
    ownerSleepPtyIncarnationId: _ownerSleepPtyIncarnationId,
    ...checkpoint
  } = entry.record
  useAppStore.setState((s) => ({
    sleepingAgentSessionsByPaneKey: {
      ...s.sleepingAgentSessionsByPaneKey,
      [paneKey]: { ...checkpoint, paneKey, tabId, origin: 'live' }
    }
  }))
  return { kept: true }
}
