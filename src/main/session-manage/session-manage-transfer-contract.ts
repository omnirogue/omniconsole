import type { SessionManageSidebarRow } from '../../shared/session-manage-relay'
import type { SessionManageAction, SessionManageActor } from '../../shared/session-manage-types'
import type {
  SessionArchiveOutcome,
  SessionTransferResult
} from '../../shared/session-transfer-types'
import type { AskWaitResult } from './session-manage-ask-wait'
import {
  assertDeliverable,
  SessionManageRefusal,
  type SessionDeliveryTarget
} from './session-manage-deliver'
import { SessionManagePartialError } from './session-manage-refusal'
import type {
  SessionTransferHostDeps,
  SessionTransferHostRequest
} from './session-transfer-host-contract'
import type { SessionTransferHostedDeps } from './session-transfer-hosted-sources'
import type { HostTransferSource } from './session-transfer-host-sources'

export type TransferSession = SessionDeliveryTarget & { row: SessionManageSidebarRow }
export type TransferPending = {
  sent: string
  wait: Promise<AskWaitResult>
  acknowledgement?: string
}
export type TransferAudit = {
  actor: SessionManageActor
  action: SessionManageAction
  target: TransferSession
  summary: string
  reason?: string
  after?: unknown
}
export type SessionTransferDeps = {
  refresh(target: TransferSession, waitForLaunch?: boolean): Promise<TransferSession>
  ask(target: TransferSession, question: string): Promise<TransferPending>
  deliver(target: TransferSession, prompt: string): Promise<TransferPending>
  create(source: TransferSession, title: string): Promise<TransferSession>
  file(target: TransferSession, source: TransferSession): Promise<void>
  assertCheckpoints(targets: TransferSession[]): void
  archive(
    sources: TransferSession[],
    reason: string,
    guard: () => boolean,
    target: TransferSession
  ): Promise<SessionArchiveOutcome>
  audit(record: TransferAudit): Promise<string | undefined>
  /** Only for a move to another computer (`--host`). */
  host?: SessionTransferHostDeps
  /** Only where sources may run under a session host (another computer, or this one's registry). */
  hosted?: SessionTransferHostedDeps
  signal?: AbortSignal
  dispose?(): void
}
export type SessionTransferInput = {
  actor: SessionManageActor
  sources: TransferSession[]
  target: TransferSession | 'new'
  dryRun: boolean
  note?: string
  skipBusy?: boolean
  /** Start the new target on another computer instead of the first source's workspace. */
  host?: SessionTransferHostRequest
  /** Sources that run under a session host, each reserved, asked and settled at its own host. */
  hostSources?: HostTransferSource[]
}
export type SessionTransferMode = 'handoff' | 'consolidate'

export function assertTransferSession(
  actor: SessionManageActor,
  target: TransferSession,
  idleOnly = false
): void {
  const { entry } = target
  if (
    entry.archived ||
    (entry.state !== 'idle' && (idleOnly || entry.state !== 'waiting-for-yes'))
  ) {
    throw new SessionManageRefusal(
      `“${entry.title}” is ${entry.archived ? 'archived' : entry.state}${entry.waitingOn ? `: ${entry.waitingOn}` : ''}; requires ${idleOnly ? 'idle' : 'idle or waiting-for-yes'}.`
    )
  }
  assertDeliverable(actor, target, 'ask')
}

/** The full brief identity comes first so bounded hook prompt prefixes still contain it. */
export function transferBriefTag(uuid: string): string {
  return `[Brief b-${uuid}] `
}

export function transferIdentity(target: TransferSession): {
  paneKey: string | null
  title: string
} {
  return { paneKey: target.entry.paneKey, title: target.entry.title }
}

export function answered(outcome: AskWaitResult): string {
  if (outcome.outcome === 'failed') {
    throw new Error(outcome.reason)
  }
  if (outcome.outcome === 'timeout') {
    throw new Error(
      `Timed out; prompt ${outcome.question === 'withdrawn' ? 'withdrawn unsent' : 'already delivered'}.${outcome.note ? ` ${outcome.note}` : ''}`
    )
  }
  if (!outcome.reply.trim()) {
    throw new Error('The finished turn contained no reply.')
  }
  return outcome.reply
}

export function transferSummary(result: SessionTransferResult): string {
  const skipped = result.skipped
    .map((entry) => `Skipped “${entry.title}”: ${entry.reason}`)
    .join(' ')
  const changed =
    result.outcome === 'failed' && result.applied?.length
      ? `Changed so far: ${result.applied.join(' ')}`
      : ''
  return [result.summary, changed, skipped].filter(Boolean).join(' ')
}

/** What a failed transfer says: the step, the reason, the archive state and whether the brief went. */
export function transferFailureSummary(
  mode: SessionTransferMode,
  step: string,
  result: SessionTransferResult
): string {
  const archived =
    result.archiveOutcome === 'unknown'
      ? 'Source archival is unconfirmed; sources may already be archived.'
      : result.archiveOutcome === 'not-archived'
        ? 'The sources are currently unarchived.'
        : 'No sources were archived.'
  const sent = result.briefSent
    ? ' The brief already queued or delivered to the target stays sent.'
    : ''
  return `${mode} failed at ${step}: ${result.failure} ${archived}${sent}`
}

/** A failed transfer audits what a partly applied step changed and each unconfirmed archive. */
export async function auditTransferFailure(
  error: unknown,
  changing: Pick<TransferAudit, 'action' | 'target'> | null,
  result: SessionTransferResult,
  sources: readonly TransferSession[],
  audit: (record: Omit<TransferAudit, 'actor'>) => Promise<void>
): Promise<void> {
  // The core's delivery changed something (Keep going off) before its queueing failed.
  if (error instanceof SessionManagePartialError && changing) {
    await audit({
      ...changing,
      summary: `Partly applied: ${error.message}`,
      after: { applied: error.applied, completed: false }
    })
  }
  if (result.archiveOutcome === 'unknown') {
    for (const source of sources) {
      await audit({
        action: 'session.archive',
        target: source,
        summary: `Archive outcome for “${source.entry.title}” is unconfirmed.`,
        after: { archived: 'unknown', completed: false }
      })
    }
  }
}
