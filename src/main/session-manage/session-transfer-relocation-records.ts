/**
 * A relocation's working files on one host, beside that account's session host registry: the
 * source's exported snapshot, and the destination's prepared place, staged bundle and staging
 * receipt. Keyed by the relocation's operation id, so a repeated step finds its own earlier work.
 */

import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionHostRelocationProvider } from '../../shared/session-host-capabilities'
import { isSessionHostOperationId } from '../../shared/session-host-identity'
import { durableWriteTempPath, writeFileDurableSync } from '../durable-file-write'
import type { SessionHostAdmissionStore } from '../session-host/session-host-admission-store'
import type { SessionHostWorkspace } from '../session-host/session-host-journal'
import type { SessionHostRelocationManifest } from '../../shared/session-host-payload-schema'
import type { RelocationBundleFile } from '../session-relocation/relocation-bundle-files'
import type { RelocationResumeIdentity } from '../session-relocation/relocation-provider-adapter'

export type RelocationPreparedPlace = {
  relocation: string
  conversationId: string
  provider: SessionHostRelocationProvider
  sourceHostId: string
  /** The epoch this host will own once it consumes the grant. */
  ownerEpoch: number
  providerRoot: string
  workspace: SessionHostWorkspace
  providerVersion: string
  at: number
}

export type RelocationStagedReceipt = {
  relocation: string
  manifestDigest: string
  manifest: SessionHostRelocationManifest
  /** Where each manifest file landed in this computer's provider home. */
  files: RelocationBundleFile[]
  identity: RelocationResumeIdentity
  at: number
}

export function relocationWorkDir(store: SessionHostAdmissionStore, relocation: string): string {
  if (!isSessionHostOperationId(relocation)) {
    throw new Error('A relocation is named by its operation id.')
  }
  return join(store.file.root, 'relocations', relocation)
}

/** The source's frozen copy of the conversation, read by the requesting computer's channel. */
export function relocationExportDir(store: SessionHostAdmissionStore, relocation: string): string {
  return join(relocationWorkDir(store, relocation), 'export')
}

/** Where the requesting computer's channel writes the bundle before `relocate.stage`. */
export function relocationStagingDir(store: SessionHostAdmissionStore, relocation: string): string {
  return join(relocationWorkDir(store, relocation), 'bundle')
}

function readRecord<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}

function writeRecord(path: string, value: unknown): void {
  writeFileDurableSync(durableWriteTempPath(path), path, `${JSON.stringify(value, null, 2)}\n`)
}

export function writeRelocationPlace(
  store: SessionHostAdmissionStore,
  place: RelocationPreparedPlace
): void {
  const dir = relocationWorkDir(store, place.relocation)
  mkdirSync(relocationStagingDir(store, place.relocation), { recursive: true })
  writeRecord(join(dir, 'place.json'), place)
}

export function readRelocationPlace(
  store: SessionHostAdmissionStore,
  relocation: string
): RelocationPreparedPlace | null {
  return readRecord(join(relocationWorkDir(store, relocation), 'place.json'))
}

export function writeRelocationStaged(
  store: SessionHostAdmissionStore,
  receipt: RelocationStagedReceipt
): void {
  writeRecord(join(relocationWorkDir(store, receipt.relocation), 'staged.json'), receipt)
}

export function readRelocationStaged(
  store: SessionHostAdmissionStore,
  relocation: string
): RelocationStagedReceipt | null {
  return readRecord(join(relocationWorkDir(store, relocation), 'staged.json'))
}
