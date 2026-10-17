import { useAppStore } from '@/store'
import {
  IDLE_RULE,
  type HibernationEvidence,
  type IdleKeepReason
} from '../../../shared/idle-auto-close-settings'
import type { AgentHibernationCandidate } from './agent-hibernation-planner'
import type { AgentSleepPolicy } from './agent-sleep-policy'
import { recordHibernationLine } from './idle-auto-close/idle-auto-close-audit'

/** The kept-count summary is written when its counts change, at most this often. */
export const AGENT_SLEEP_SUMMARY_MIN_INTERVAL_MS = 15 * 60 * 1000

let lastSummary: { json: string; at: number } | null = null

function candidateEvidence(
  candidate: AgentHibernationCandidate,
  policy: AgentSleepPolicy,
  now: number,
  extra: HibernationEvidence
): HibernationEvidence {
  const entry = useAppStore.getState().agentStatusByPaneKey[candidate.paneKey]
  return {
    worktreeId: candidate.worktreeId,
    source: policy.source,
    idleMs: policy.idleMs,
    ptyId: candidate.targetPtyIds[0] ?? null,
    agentType: entry?.agentType ?? null,
    doneSince: entry?.stateStartedAt ?? null,
    idleForMs: entry?.stateStartedAt ? Math.max(0, now - entry.stateStartedAt) : null,
    ...(policy.refused ? { refused: policy.refused } : {}),
    ...extra
  }
}

function tabTitle(candidate: AgentHibernationCandidate): string | undefined {
  const tab = (useAppStore.getState().tabsByWorktree[candidate.worktreeId] ?? []).find(
    (entry) => entry.id === candidate.tabId
  )
  return tab ? tab.customTitle || tab.title : undefined
}

export type AgentSleepOutcome = 'would' | 'done' | 'failed'

/** One R1 line: a sleep done, failed, or (shadow) what it would have done. */
export function recordAgentSleep(
  candidate: AgentHibernationCandidate,
  policy: AgentSleepPolicy,
  outcome: AgentSleepOutcome,
  now: number,
  extra: HibernationEvidence = {}
): void {
  const title = tabTitle(candidate)
  const summary =
    outcome === 'would'
      ? policy.refused
        ? 'Would put a done agent to sleep; On is held back until the restore flood guard is on.'
        : 'Would put a done agent to sleep (shadow).'
      : outcome === 'done'
        ? 'Put a done agent to sleep; opening its tab resumes it.'
        : 'Could not put a done agent to sleep.'
  recordHibernationLine(
    {
      action: 'hibernation.sleep',
      target: { paneKey: candidate.paneKey, tabId: candidate.tabId, ...(title ? { title } : {}) },
      summary,
      audit: {
        rule: IDLE_RULE.R1,
        mode: outcome === 'would' ? 'shadow' : 'on',
        outcome,
        evidence: candidateEvidence(candidate, policy, now, extra)
      }
    },
    outcome === 'would' ? `R1|${candidate.id}|${candidate.signature}|would` : null
  )
}

/** The done entry outlived its agent (its terminal is back at the login shell). */
export function recordStaleDoneDrop(
  candidate: AgentHibernationCandidate,
  policy: AgentSleepPolicy,
  acted: boolean,
  now: number,
  extra: HibernationEvidence
): void {
  const title = tabTitle(candidate)
  recordHibernationLine(
    {
      action: 'hibernation.drop-stale-done',
      target: { paneKey: candidate.paneKey, tabId: candidate.tabId, ...(title ? { title } : {}) },
      summary: acted
        ? 'Its agent had exited (the terminal is at its shell): dropped the stale done entry and wrote no resume record.'
        : 'Its agent has exited (the terminal is at its shell): would drop the stale done entry, and writes no resume record.',
      audit: {
        rule: IDLE_RULE.R1,
        mode: acted ? 'on' : 'shadow',
        outcome: acted ? 'done' : 'would',
        evidence: candidateEvidence(candidate, policy, now, extra)
      }
    },
    `R1|${candidate.id}|${candidate.signature}|drop|${acted}`
  )
}

/** One line counting why done agents stayed awake, written when the counts change. */
export function recordAgentSleepSummary(
  policy: AgentSleepPolicy,
  confirmed: number,
  kept: Partial<Record<IdleKeepReason, number>>,
  now: number
): void {
  const counts = Object.fromEntries(
    Object.entries(kept)
      .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && entry[1] > 0)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([reason, value]) => [`kept.${reason}`, value])
  )
  const json = JSON.stringify({ confirmed, ...counts })
  if (
    lastSummary &&
    (lastSummary.json === json || now - lastSummary.at < AGENT_SLEEP_SUMMARY_MIN_INTERVAL_MS)
  ) {
    return
  }
  lastSummary = { json, at: now }
  const keptTotal = Object.values(counts).reduce((sum, value) => sum + value, 0)
  recordHibernationLine({
    action: 'idle.summary',
    target: {},
    summary: `Agent sleep check: ${confirmed} ready, kept ${keptTotal} done agents awake.`,
    audit: {
      rule: IDLE_RULE.SUMMARY,
      mode: policy.mode,
      outcome: 'kept',
      evidence: { source: policy.source, idleMs: policy.idleMs, confirmed, ...counts }
    }
  })
}

export function resetAgentSleepAuditForTests(): void {
  lastSummary = null
}
