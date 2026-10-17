/** What R2 and R3 do once a target passed G4, and the line each decision writes. */

import type { AppState } from '@/store/types'
import {
  IDLE_RULE,
  type HibernationEvidence,
  type IdleAutoCloseGate
} from '../../../../shared/idle-auto-close-settings'
import { recordHibernationLine } from './idle-auto-close-audit'
import type { IdleDecision, IdleRule } from './idle-auto-close-decision'
import type { IdleAutoCloseDeps } from './idle-auto-close-deps'
import { shellWorkspaceWindowKeepReason } from './idle-auto-close-recheck'

const RULE_LINE = {
  [IDLE_RULE.R2]: {
    action: 'idle.sleep-shells',
    verb: 'put an idle shell-only workspace to sleep, keeping its history'
  },
  [IDLE_RULE.R3]: { action: 'idle.discard-page', verb: 'discard hidden browser pages' }
} as const satisfies Record<IdleRule, { action: string; verb: string }>

export function recordIdleDecision(
  decision: IdleDecision,
  gate: Exclude<IdleAutoCloseGate, { mode: 'off' }>,
  outcome: 'would' | 'done' | 'failed',
  extra: HibernationEvidence = {}
): void {
  const { action, verb } = RULE_LINE[decision.rule]
  const refused = gate.mode === 'shadow' ? gate.refused : undefined
  recordHibernationLine(
    {
      action,
      target: decision.target,
      summary:
        outcome === 'would'
          ? refused
            ? `Would ${verb}; On is held back until the restore flood guard is on.`
            : `Would ${verb} (shadow).`
          : outcome === 'done'
            ? `Idle rule: ${verb}.`
            : `Could not ${verb}.`,
      audit: {
        rule: decision.rule,
        mode: outcome === 'would' ? 'shadow' : 'on',
        outcome,
        evidence: { ...decision.evidence, ...(refused ? { refused } : {}), ...extra }
      }
    },
    `${decision.rule}|${decision.key}|${decision.signature}|${outcome}`
  )
}

export type IdleActResult =
  | { kept: string }
  | { evidence: HibernationEvidence }
  | { failed: string }

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * R2 puts the workspace's shells to sleep the way a person's Sleep does (every PTY stops and keeps
 * its history; tabs and layouts stay, so opening the workspace restores each shell with its
 * output). R3 discards the pages. Never throws: a failure comes back as `failed`, and the store's
 * stop rolls back what it could not finish, leaving the shells retryable.
 */
export async function actOnIdleDecision(
  deps: IdleAutoCloseDeps,
  decision: IdleDecision,
  state: AppState,
  now: () => number
): Promise<IdleActResult> {
  try {
    if (decision.rule === IDLE_RULE.R3) {
      deps.discardWorktreeGuests(state, decision.key)
      return { evidence: {} }
    }
    // G4: nothing awaited since the re-check, but it costs nothing to read the window once more.
    const kept = shellWorkspaceWindowKeepReason(decision, now())
    if (kept) {
      return { kept }
    }
    await deps.sleepShellWorkspace(decision.key)
    return { evidence: { keptHistory: true, tabs: decision.shellTabs?.length ?? 0 } }
  } catch (error) {
    return { failed: message(error) }
  }
}
