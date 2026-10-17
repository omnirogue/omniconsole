/**
 * What `session relocate` reports: the same conversation moved to another computer, step by step.
 * `blocked` means the move stopped where only a later query (never a resend or a restart) can
 * finish it; the source never restarts on its own once it relinquished the conversation.
 */

import type { SessionHostRelocationProvider } from './session-host-capabilities'

export const SESSION_RELOCATION_STEPS = [
  'prepare-destination',
  'reserve-source',
  'freeze-source',
  'export',
  'copy',
  'stage',
  'relinquish',
  'resume',
  'release-source'
] as const
export type SessionRelocationStep = (typeof SESSION_RELOCATION_STEPS)[number]

export type SessionRelocationOutcome =
  /** An unattended caller asked: it is written up for a person, and nothing moved. */
  | 'proposed'
  /** Dry run: checked and listed, nothing moved. */
  | 'planned'
  /** Refused before the source was frozen; nothing changed. */
  | 'refused'
  /** Stopped before relinquishment; the source was released and still owns it. */
  | 'abandoned'
  /** The destination resumed it and its provider reported the same conversation. */
  | 'relocated'
  /** The destination owns it but did not confirm the same conversation is running; a person checks. */
  | 'owned-unconfirmed'
  /** Outcome unknown at a host that could not be reached; only a later query may finish it. */
  | 'blocked'

export type SessionRelocationStepRecord = {
  step: SessionRelocationStep
  operationId: string | null
  /** The operation's recorded state, `unreachable`, or `done` for the copy. */
  state: string
  detail?: string
}

export type SessionRelocationResult = {
  relocation: string | null
  outcome: SessionRelocationOutcome
  provider: SessionHostRelocationProvider | null
  source: { hostId: string; label: string; conversationId: string }
  destination: { hostId: string; label: string }
  /** The owner epoch the destination holds once relocated. */
  ownerEpoch?: number
  steps: SessionRelocationStepRecord[]
  summary: string
  /** The refusal code that decided it, when one did. */
  code?: string
}

/** `omni session relocate`: always a person's explicit request from this computer's CLI. */
export const SESSION_RELOCATE_RPC = 'sessionManage.relocate' as const

export type SessionRelocateCommandParams = {
  /** `local`, `ssh:<id>` or `runtime:<id>`, as `omni session hosts` names them. */
  to: string
  /** The folder (or git checkout) on the destination the conversation continues in. */
  workspace: string
  /** The commit the destination's checkout must be at; defaults to this computer's HEAD. */
  commit?: string
  /** Continue an earlier move that stopped (blocked) with its recorded requests. */
  relocation?: string
  dryRun?: boolean
  reason?: string
  request?: string
}
