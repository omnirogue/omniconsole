/**
 * What carries out an admitted action on this host. Package A owns admission; the executor (package
 * B's owner service, with C's transfers and relocation and D's organization) supplies the live
 * facts admission reads and does the work. Until one is installed the stub refuses everything and
 * nothing is advertised, because a host must not advertise what it cannot carry out.
 */

import type { SessionHostAuthority } from '../../shared/session-host-authority'
import {
  SESSION_CONTROL_OWNER_CAPABILITY,
  SESSION_HOST_CAPABILITIES,
  SESSION_HOST_CAPABILITY_PREREQUISITES,
  SESSION_ORGANIZATION_HOST_CAPABILITY,
  SESSION_RELOCATION_BUNDLE_CAPABILITY,
  SESSION_RELOCATION_CAPABILITY_BY_PROVIDER,
  SESSION_WAITS_REMOTE_CAPABILITY,
  type SessionHostCapability
} from '../../shared/session-host-capabilities'
import type {
  SessionHostAction,
  SessionHostHistoryParams,
  SessionHostHistoryResult,
  SessionHostRequest,
  SessionHostSessionRef,
  SessionHostTidyParams,
  SessionHostTidyResult,
  SessionHostWaitStatusParams,
  SessionHostWaitStatusResult
} from '../../shared/session-host-protocol'
import { sessionHostRefusal, type SessionHostRefusal } from '../../shared/session-host-refusal'
import type { SessionManageEntry } from '../../shared/session-manage-types'
import type { SessionExecutionVerdict } from '../../shared/session-host-verdict'
import type { SessionHostTurnReading } from './session-host-admission-facts'
import type { SessionHostJournalOperation, SessionHostRegistration } from './session-host-journal'
import type { SessionHostSettlement } from './session-host-settlement'

/** A request as the executor sees it: the origin, if any, is in the authority. */
export type SessionHostExecutionRequest = {
  [A in SessionHostAction]: Omit<SessionHostRequest<A>, 'origin'>
}[SessionHostAction]

/** What only this host's own observation can say about one conversation. */
export type SessionHostLiveObservation = {
  verdict: SessionExecutionVerdict
  turnRevision: string | null
  organizationRevision?: string
  ref?: Partial<Pick<SessionHostSessionRef, 'paneKey' | 'tabId' | 'worktreePath'>>
  entry?: SessionManageEntry
  /** Left out of observe unless it asks for archived sessions. */
  archived?: boolean
  /** A kill switch is on: no new automatic admissions. */
  automationDisabled?: boolean
}

export type SessionHostExecutionInput = {
  request: SessionHostExecutionRequest
  authority: SessionHostAuthority
  /** Admitted and durable; dispatch is recorded before `dispatch` runs. */
  operation: SessionHostJournalOperation
  /** Null for a relocation destination that owns nothing yet. */
  registration: SessionHostRegistration | null
  /** The `[from …] ` marker every delivered message must start with. */
  marker: string
}

export type SessionHostPrepared =
  /** Checked and refused before anything moved (policy, hard stop, a driver, person input). */
  | { kind: 'refuse'; refusal: SessionHostRefusal }
  | { kind: 'dispatch'; dispatch: () => Promise<SessionHostSettlement> }

export type SessionHostExecutor = {
  /** What this host can carry out. Only these are advertised, and only with their methods. */
  capabilities(): readonly SessionHostCapability[]
  /** False while the executor reconciles its queue and process incarnations after a restart. */
  reconciled(): boolean
  /** Read inside the admission lock: the conversation's current turn and organization revision. */
  readTurn(registration: SessionHostRegistration): Promise<SessionHostTurnReading>
  /** Registers the sessions this host runs that the registry does not list yet; before observe. */
  register?(): Promise<void>
  observe(
    registrations: readonly SessionHostRegistration[],
    options: { includeArchived: boolean }
  ): Promise<ReadonlyMap<string, SessionHostLiveObservation>>
  prepare(input: SessionHostExecutionInput): Promise<SessionHostPrepared>
  tidy?(
    params: SessionHostTidyParams,
    authority: SessionHostAuthority
  ): Promise<SessionHostTidyResult>
  history?(params: SessionHostHistoryParams): Promise<SessionHostHistoryResult>
  waitStatus?(params: SessionHostWaitStatusParams): Promise<SessionHostWaitStatusResult>
}

const READ_TURN_TIMEOUT_MS = 5_000

/** Bounded, because it runs while the account's writer lock is held. */
export async function readSessionHostTurn(
  executor: SessionHostExecutor,
  registration: SessionHostRegistration
): Promise<SessionHostTurnReading> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<SessionHostTurnReading>((resolve) => {
    timer = setTimeout(() => resolve('unreadable'), READ_TURN_TIMEOUT_MS)
  })
  try {
    return await Promise.race([executor.readTurn(registration), timeout])
  } finally {
    clearTimeout(timer)
  }
}

export function sessionHostNotSupportedYet(action: string): SessionHostRefusal {
  return sessionHostRefusal(
    'unsupported-capability',
    `This computer's OmniConsole cannot carry out ${action} on this host yet. Nothing was changed.`
  )
}

/** Until package B installs the owner service: nothing is advertised and every action refuses. */
export const UNSUPPORTED_SESSION_HOST_EXECUTOR: SessionHostExecutor = {
  capabilities: () => [],
  reconciled: () => true,
  readTurn: async () => ({ turnRevision: null, organizationRevision: null }),
  observe: async () => new Map(),
  prepare: async ({ request }) => ({
    kind: 'refuse',
    refusal: sessionHostNotSupportedYet(request.action)
  })
}

/**
 * What this host may advertise: what the executor claims, only where the methods behind it exist
 * (organization needs tidy and history, waits need waitStatus), and only with its prerequisites.
 */
export function advertisableSessionHostCapabilities(
  executor: SessionHostExecutor
): SessionHostCapability[] {
  const claimed = new Set(executor.capabilities())
  const backed = SESSION_HOST_CAPABILITIES.filter(
    (capability) =>
      claimed.has(capability) &&
      (capability !== SESSION_ORGANIZATION_HOST_CAPABILITY ||
        (executor.tidy && executor.history)) &&
      (capability !== SESSION_WAITS_REMOTE_CAPABILITY || executor.waitStatus)
  )
  const relocates = backed.some((capability) =>
    Object.values(SESSION_RELOCATION_CAPABILITY_BY_PROVIDER).includes(capability)
  )
  return backed.includes(SESSION_CONTROL_OWNER_CAPABILITY)
    ? backed.filter(
        (capability) =>
          SESSION_HOST_CAPABILITY_PREREQUISITES[capability].every((needed) =>
            backed.includes(needed)
          ) &&
          // Why: moving a bundle is only offered beside a provider's relocation.
          (capability !== SESSION_RELOCATION_BUNDLE_CAPABILITY || relocates)
      )
    : []
}
