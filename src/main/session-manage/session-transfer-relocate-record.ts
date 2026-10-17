/**
 * The requesting computer's durable record of one relocation: every step's request, written before
 * it is sent, and the grant as soon as the source issues it. Continuing an interrupted move resends
 * exactly those requests (each host replays its recorded outcome by id), so nothing is ever sent
 * twice under a different id and a lost acknowledgment is recovered by asking, never by retrying.
 */

import type { SessionHostRelocationProvider } from '../../shared/session-host-capabilities'
import type { SessionHostOwnershipGrant } from '../../shared/session-host-identity'
import type { SessionHostRelocationManifest } from '../../shared/session-host-payload-schema'
import type { SessionHostRequest } from '../../shared/session-host-protocol'
import type {
  SessionRelocationStep,
  SessionRelocationStepRecord
} from '../../shared/session-relocation-types'
import {
  fileSessionTransferRecords,
  memorySessionTransferRecords,
  type SessionTransferRecordStore
} from './session-transfer-record-files'

export type SessionRelocationRecord = {
  v: 1
  relocation: string
  provider: SessionHostRelocationProvider
  source: { hostId: string; conversationId: string; ownerEpoch: number }
  destination: { hostId: string }
  /** Each step's request exactly as sent; a continuation resends these and nothing else. */
  requests: Partial<Record<SessionRelocationStep, SessionHostRequest>>
  /** The source's reservation (the `reserve-source` operation id) while it holds. */
  reservation?: string
  stagingDir?: string
  exportDir?: string
  manifest?: SessionHostRelocationManifest
  /** The destination verified and filed the bundle. */
  staged?: boolean
  /** Persisted the moment the source issues it: only this lets the destination take over. */
  grant?: SessionHostOwnershipGrant
  /** Set while the source's reservation is being given back; a continuation finishes that. */
  releasing?: boolean
  steps: SessionRelocationStepRecord[]
  phase: 'running' | 'blocked' | 'abandoned' | 'relocated' | 'owned-unconfirmed'
  updatedAt: number
}

export type SessionRelocationRecords = SessionTransferRecordStore<SessionRelocationRecord>

/** One JSON file per relocation under the requesting computer's own profile. */
export function fileSessionRelocationRecords(dir: string): SessionRelocationRecords {
  return fileSessionTransferRecords<SessionRelocationRecord>(dir, (record) => record.relocation)
}

export function memorySessionRelocationRecords() {
  return memorySessionTransferRecords<SessionRelocationRecord>((record) => record.relocation)
}

/** Replaces the step's entry (a continuation re-runs it) and keeps the order steps ran in. */
export function noteRelocationStep(
  record: SessionRelocationRecord,
  entry: SessionRelocationStepRecord
): void {
  record.steps = [...record.steps.filter((step) => step.step !== entry.step), entry]
}
