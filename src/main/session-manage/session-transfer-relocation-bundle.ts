/**
 * The execution host's side of moving a relocation bundle: the source serves chunks of the files
 * its completed export listed, and the destination appends chunks into its staging area for a move
 * it was prepared for. Only the peer that ran that step may read or write, nothing is written after
 * staging, and every path stays inside the bundle. Staging checks the result against the manifest.
 */

import { lstat, mkdir, open } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  SessionHostBundleReadParams,
  SessionHostBundleReadResult,
  SessionHostBundleWriteParams,
  SessionHostBundleWriteResult
} from '../../shared/session-host-relocation-bundle'
import type { SessionHostRelocationManifest } from '../../shared/session-host-payload-schema'
import { sessionHostRefusal, type SessionHostRefusal } from '../../shared/session-host-refusal'
import type { SessionHostAdmissionStore } from '../session-host/session-host-admission-store'
import type { SessionHostJournalOperation } from '../session-host/session-host-journal'
import { isCredentialShapedPath } from '../session-relocation/relocation-bundle-files'
import {
  readRelocationPlace,
  readRelocationStaged,
  relocationStagingDir
} from './session-transfer-relocation-records'

const refused = (code: SessionHostRefusal['code'], message: string) =>
  ({ status: 'refused', refusal: sessionHostRefusal(code, message) }) as const

/** The completed step of this relocation that `holder` ran on this host. */
function stepRunBy(
  store: SessionHostAdmissionStore,
  action: 'relocate.export' | 'relocate.prepare-destination',
  params: { relocation: string; conversationId: string },
  holder: string
): SessionHostJournalOperation | null {
  const operations = Object.values(store.snapshot()?.operations ?? {})
  return (
    operations.find(
      (operation) =>
        operation.action === action &&
        operation.conversationId === params.conversationId &&
        operation.state === 'completed' &&
        operation.holder === holder &&
        (operation.result as { relocation?: unknown } | undefined)?.relocation === params.relocation
    ) ?? null
  )
}

/** Refuses a link anywhere between the root and the file: a bundle never leaves its folder. */
async function plainPath(root: string, path: string): Promise<string | null> {
  let current = root
  for (const segment of path.split('/')) {
    current = join(current, segment)
    const info = await lstat(current).catch(() => null)
    if (info?.isSymbolicLink()) {
      return null
    }
  }
  return current
}

export async function readRelocationBundleChunk(
  store: SessionHostAdmissionStore,
  params: SessionHostBundleReadParams,
  holder: string
): Promise<SessionHostBundleReadResult> {
  const exported = stepRunBy(store, 'relocate.export', params, holder)
  const result = exported?.result as
    | { exported?: unknown; manifest?: SessionHostRelocationManifest; exportDir?: unknown }
    | undefined
  if (result?.exported !== true || !result.manifest || typeof result.exportDir !== 'string') {
    return refused(
      'not-eligible',
      'This computer exported no such bundle for this requester. Nothing was read.'
    )
  }
  const file = result.manifest.files.find((entry) => entry.path === params.path)
  if (!file || params.offset > file.bytes) {
    return refused('invalid-request', `${params.path} is not in that bundle. Nothing was read.`)
  }
  const absolute = await plainPath(result.exportDir, params.path)
  if (!absolute) {
    return refused('not-eligible', `${params.path} is a link. Nothing was read.`)
  }
  const length = Math.min(params.length, file.bytes - params.offset)
  const handle = await open(absolute, 'r')
  try {
    const bytes = Buffer.alloc(length)
    const { bytesRead } = await handle.read(bytes, 0, length, params.offset)
    return {
      status: 'ok',
      path: params.path,
      offset: params.offset,
      size: file.bytes,
      base64: bytes.subarray(0, bytesRead).toString('base64')
    }
  } finally {
    await handle.close()
  }
}

export async function writeRelocationBundleChunk(
  store: SessionHostAdmissionStore,
  params: SessionHostBundleWriteParams,
  holder: string
): Promise<SessionHostBundleWriteResult> {
  const place = readRelocationPlace(store, params.relocation)
  if (
    !place ||
    place.conversationId !== params.conversationId ||
    place.provider !== params.provider ||
    !stepRunBy(store, 'relocate.prepare-destination', params, holder)
  ) {
    return refused(
      'not-eligible',
      'This computer was not prepared for that move by this requester. Nothing was written.'
    )
  }
  if (readRelocationStaged(store, params.relocation)) {
    return refused('not-eligible', 'That move is already staged here. Nothing was written.')
  }
  if (isCredentialShapedPath(params.path)) {
    return refused(
      'not-eligible',
      `${params.path} is named like a credential, and a move never carries credentials. Nothing was written.`
    )
  }
  const bytes = Buffer.from(params.base64, 'base64')
  if (bytes.toString('base64') !== params.base64 || params.offset + bytes.length > params.size) {
    return refused(
      'invalid-request',
      'That chunk is not readable bytes of this file. Nothing was written.'
    )
  }
  const root = relocationStagingDir(store, params.relocation)
  const absolute = await plainPath(root, params.path)
  if (!absolute) {
    return refused('not-eligible', `${params.path} passes through a link. Nothing was written.`)
  }
  await mkdir(join(absolute, '..'), { recursive: true })
  const existing = await lstat(absolute).catch(() => null)
  if (existing && !existing.isFile()) {
    return refused('not-eligible', `${params.path} is not a plain file here. Nothing was written.`)
  }
  const received = existing?.size ?? 0
  const handle = await open(absolute, existing ? 'r+' : 'w+')
  try {
    if (params.offset === received) {
      await handle.write(bytes, 0, bytes.length, received)
      await handle.sync()
      return { status: 'ok', path: params.path, received: received + bytes.length, accepted: true }
    }
    if (params.offset + bytes.length <= received) {
      // Why accepted: a resent chunk the destination already holds, byte for byte.
      const held = Buffer.alloc(bytes.length)
      await handle.read(held, 0, bytes.length, params.offset)
      return { status: 'ok', path: params.path, received, accepted: held.equals(bytes) }
    }
    return { status: 'ok', path: params.path, received, accepted: false }
  } finally {
    await handle.close()
  }
}
