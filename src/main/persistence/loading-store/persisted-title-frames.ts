// Why: agent CLIs animate a leading spinner in their OSC title; persisting each frame made a
// frame-only change rewrite the whole omni-data.json (#857). Canonicalize the frame, never strip
// it: the glyph family still carries the agent and working/idle meaning restored labels rely on.
// Only the proven one-state spinner families collapse (braille; Claude 2.1.228+ quarter circles,
// #13889 — the set agent-decorative-title-signature treats as frames). Distinct-state glyphs
// (✳ idle, Gemini's, bracketed markers from unknown agents) are left alone.
import { isDeepStrictEqual } from 'node:util'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import type { Tab } from '../../../shared/tab-types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'

const QUARTER_CIRCLE_FRAME_RE = /^[◐-◓]+/
const BRAILLE_FRAME_RE = /^[⠀-⣿]+/

export function canonicalizeAgentTitleFrame(title: string): string {
  if (!title) {
    return title
  }
  return title.replace(QUARTER_CIRCLE_FRAME_RE, '◐').replace(BRAILLE_FRAME_RE, '⠋')
}

/** True when two sessions persist identically once spinner frames are canonicalized. */
export function isTitleFrameOnlySessionChange(
  prior: WorkspaceSessionState | undefined,
  next: WorkspaceSessionState | undefined
): boolean {
  if (!prior || !next || prior === next) {
    return false
  }
  return isDeepStrictEqual(comparableCanonicalSession(prior), comparableCanonicalSession(next))
}

// Why: a canonical copy adds explicit undefined keys that an untouched session lacks, and strict
// deep equality treats missing and undefined keys as different; both sides get the same keys.
function comparableCanonicalSession(session: WorkspaceSessionState): WorkspaceSessionState {
  const canonical = canonicalizePersistedSessionTitles(session)
  return {
    ...canonical,
    tabsByWorktree: canonical.tabsByWorktree,
    unifiedTabs: canonical.unifiedTabs,
    sleepingAgentSessionsByPaneKey: canonical.sleepingAgentSessionsByPaneKey
  }
}

function canonicalizeTabList<T extends object>(
  tabsByWorktree: Record<string, T[]> | undefined,
  key: 'title' | 'label'
): Record<string, T[]> | undefined {
  if (!tabsByWorktree) {
    return tabsByWorktree
  }
  let changed = false
  const next: Record<string, T[]> = {}
  for (const [worktreeId, tabs] of Object.entries(tabsByWorktree)) {
    next[worktreeId] = Array.isArray(tabs)
      ? tabs.map((tab) => {
          const value = (tab as Record<string, unknown>)?.[key]
          if (typeof value !== 'string') {
            return tab
          }
          const canonical = canonicalizeAgentTitleFrame(value)
          if (canonical === value) {
            return tab
          }
          changed = true
          return { ...tab, [key]: canonical }
        })
      : tabs
  }
  return changed ? next : tabsByWorktree
}

/** A copy of the session with spinner frames canonicalized; the live session is never mutated. */
export function canonicalizePersistedSessionTitles(
  session: WorkspaceSessionState
): WorkspaceSessionState {
  if (!session || typeof session !== 'object') {
    return session
  }
  const tabsByWorktree = canonicalizeTabList<TerminalTab>(session.tabsByWorktree, 'title')
  const unifiedTabs = canonicalizeTabList<Tab>(session.unifiedTabs, 'label')
  const sleepingSource = session.sleepingAgentSessionsByPaneKey
  let sleepingCopy: Record<string, SleepingAgentSessionRecord> | null = null
  for (const [paneKey, record] of Object.entries(sleepingSource ?? {})) {
    const title = record?.terminalTitle
    const canonical = typeof title === 'string' ? canonicalizeAgentTitleFrame(title) : title
    if (canonical !== title) {
      sleepingCopy ??= { ...sleepingSource }
      sleepingCopy[paneKey] = { ...record, terminalTitle: canonical }
    }
  }
  if (
    tabsByWorktree === session.tabsByWorktree &&
    unifiedTabs === session.unifiedTabs &&
    sleepingCopy === null
  ) {
    return session
  }
  // Why explicit keys: an overridden key keeps its position, and an absent one serializes as nothing.
  return {
    ...session,
    tabsByWorktree: tabsByWorktree ?? session.tabsByWorktree,
    unifiedTabs,
    sleepingAgentSessionsByPaneKey: sleepingCopy ?? sleepingSource
  }
}

type SessionsByHostId = PersistedState['workspaceSessionsByHostId']

export function canonicalizePersistedHostSessionTitles(
  sessionsByHostId: SessionsByHostId
): SessionsByHostId {
  if (!sessionsByHostId) {
    return sessionsByHostId
  }
  let next: Record<string, WorkspaceSessionState | undefined> | null = null
  for (const [hostId, session] of Object.entries(sessionsByHostId)) {
    const canonical = session ? canonicalizePersistedSessionTitles(session) : session
    if (canonical !== session) {
      next ??= { ...sessionsByHostId }
      next[hostId] = canonical
    }
  }
  return (next as SessionsByHostId | null) ?? sessionsByHostId
}
