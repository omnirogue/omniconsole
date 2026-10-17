/**
 * What the execution host's transfer and relocation steps need from the live session they act on.
 * B's executor (or a relay) supplies these; they are the only pieces that touch panes, providers
 * and accounts, so the steps themselves stay Electron-free and testable.
 */

import type { ConversationSource } from '../../shared/conversation-source'
import type { SessionHostAuthority } from '../../shared/session-host-authority'
import type {
  SessionHostCapability,
  SessionHostRelocationProvider
} from '../../shared/session-host-capabilities'
import type { SessionHostAction } from '../../shared/session-host-protocol'
import type { SessionHostPayloads } from '../../shared/session-host-payload-schema'
import type { SessionHostRefusal } from '../../shared/session-host-refusal'
import type { SessionHostAdmissionStore } from '../session-host/session-host-admission-store'
import type {
  SessionHostExecutionInput,
  SessionHostPrepared
} from '../session-host/session-host-executor'
import type {
  SessionHostRegistration,
  SessionHostWorkspace
} from '../session-host/session-host-journal'
import type { RelocationResumeIdentity } from '../session-relocation/relocation-provider-adapter'

/** The shape B's executor delegates to (it declares the same type; neither imports the other). */
export type SessionHostActionHandler = {
  capabilities(): readonly SessionHostCapability[]
  handles(action: SessionHostAction): boolean
  prepare(input: SessionHostExecutionInput): Promise<SessionHostPrepared>
}

export type TransferSourceStepInput = {
  registration: SessionHostRegistration
  operationId: string
  authority: SessionHostAuthority
}

/** A source conversation on this host, as the handoff steps use it. */
export type TransferSourceHost = {
  /** Null when it may give a brief now (idle or waiting-for-yes, unarchived, no driver). */
  eligible(input: TransferSourceStepInput): Promise<SessionHostRefusal | null>
  /**
   * Sends the question (starting with `marker`) as this admitted operation and waits for the
   * finished reply. Throws `ConversationNotSentError` only when nothing was sent.
   */
  askBrief(
    input: TransferSourceStepInput & { marker: string; question: string }
  ): Promise<{ reply: string; turnRevision: string }>
  /** Archives it through the organization host under this operation id; never deletes or stops. */
  archive(
    input: TransferSourceStepInput & { reason: string }
  ): Promise<{ archived: true } | { archived: false; detail: string }>
}

/** Positive exit evidence for the provider and every child it started; anything else blocks. */
export type RelocationExitEvidence =
  | { stopped: true; evidence: string }
  | { stopped: false; reason: string }

export type RelocationSourceHost = {
  /** Suspends every automatic driver, stops the provider, and proves it and its children exited. */
  freeze(input: TransferSourceStepInput): Promise<RelocationExitEvidence>
  /** Re-reads exit evidence without acting (export and relinquish check it again). */
  exitEvidence(registration: SessionHostRegistration): Promise<RelocationExitEvidence>
  /** The provider's own transcript for this conversation on this host. */
  transcriptPath(registration: SessionHostRegistration): Promise<string | null>
  /** After relinquishment: the source pane stays as history and can never be resumed here. */
  retire(input: TransferSourceStepInput): Promise<void>
}

/** Where the destination would run it; refused before anything is created when it cannot. */
export type RelocationDestinationCheck =
  | { ok: true; providerRoot: string; workspace: SessionHostWorkspace; providerVersion: string }
  | { ok: false; refusal: SessionHostRefusal }

export type RelocationDestinationHost = {
  /**
   * Provider installed at a version able to read the source's, the workspace mapped (git: at the
   * intended commit; folder: explicitly and accessibly), the permissions it already has, and an
   * account with fresh capacity. Credentials stay the destination's own.
   */
  check(
    payload: SessionHostPayloads['relocate.prepare-destination']
  ): Promise<RelocationDestinationCheck>
  /** Starts the provider resuming exactly this identity in the workspace; never a fresh session. */
  launch(input: {
    identity: RelocationResumeIdentity
    workspace: SessionHostWorkspace
    conversationId: string
    operationId: string
  }): Promise<{ binding: ConversationSource; processIncarnation: string | null }>
  /** The provider's own report of which conversation the launched process opened. */
  confirm(
    binding: ConversationSource
  ): Promise<
    { state: 'same' } | { state: 'different'; reported: string } | { state: 'unconfirmed' }
  >
}

export type SessionTransferHostActionDeps = {
  store: SessionHostAdmissionStore
  /** Relocation is on unless its own switch (or `OMNI_RELOCATION_DISABLED`) turned it off. */
  relocationEnabled(): boolean
  /** Providers whose CLI this host can run; only their tested formats are advertised. */
  relocationProviders(): readonly SessionHostRelocationProvider[]
  /** Absent: this host cannot give briefs as a transfer source, so it does not advertise it. */
  transferSource?: TransferSourceHost
  relocationSource?: RelocationSourceHost
  relocationDestination?: RelocationDestinationHost
}
