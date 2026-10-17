/**
 * What relocation needs from each provider's native format: which files make up one conversation,
 * where they go on the destination, and the exact identity the destination resumes. A provider is
 * advertised for relocation only when its adapter exists here and its format checks pass.
 */

import { createReadStream } from 'node:fs'
import { open } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import type { SessionHostRelocationProvider } from '../../shared/session-host-capabilities'
import type { SessionHostRelocationManifest } from '../../shared/session-host-payload-schema'
import {
  refuseRelocation,
  SessionRelocationRefusal,
  type RelocationBundleFile
} from './relocation-bundle-files'

export type RelocationSourceConversation = { sessionId: string; transcriptPath: string }

/** The destination's own provider home (its account) and the workspace the conversation runs in. */
export type RelocationDestinationPlace = { providerRoot: string; workspacePath: string }

export type RelocationImportPlan = { files: RelocationBundleFile[]; transcriptPath: string }

/** Exactly what the destination resumes: never a fresh conversation, never another identity. */
export type RelocationResumeIdentity = {
  agent: SessionHostRelocationProvider
  sessionId: string
  transcriptPath: string
  providerRoot: string
}

export type RelocationProviderAdapter = {
  provider: SessionHostRelocationProvider
  /**
   * Every record parses, the file ends on a whole record and it is this conversation's. Returns
   * the newest provider version that wrote it, which a destination's CLI must be able to read.
   */
  checkTranscript(transcriptPath: string, sessionId: string): Promise<RelocationTranscriptCheck>
  exportFiles(source: RelocationSourceConversation): RelocationBundleFile[]
  importPlan(
    manifest: SessionHostRelocationManifest,
    place: RelocationDestinationPlace
  ): RelocationImportPlan
  /** Checked with the provider's own resume selection, with its fallbacks disabled. */
  resumeIdentity(
    plan: RelocationImportPlan,
    manifest: SessionHostRelocationManifest,
    place: RelocationDestinationPlace
  ): Promise<RelocationResumeIdentity>
}

export type RelocationTranscriptCheck = { writerVersion: string | null }

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/
const VERSION = /(\d+)\.(\d+)\.(\d+)/

/** Negative, zero or positive like a comparator; null when either is not a version. */
export function compareProviderVersions(a: string, b: string): number | null {
  const left = VERSION.exec(a)
  const right = VERSION.exec(b)
  if (!left || !right) {
    return null
  }
  for (let part = 1; part <= 3; part += 1) {
    const difference = Number(left[part]) - Number(right[part])
    if (difference !== 0) {
      return difference
    }
  }
  return 0
}

export function checkRelocationSessionId(sessionId: string): void {
  if (!SESSION_ID.test(sessionId) || sessionId.includes('..')) {
    throw refuseRelocation(
      'invalid-request',
      'That provider session id cannot name a file safely. Nothing was moved.'
    )
  }
}

/**
 * Reads a JSONL transcript whole. `accept` sees each record and returns true once identity is
 * proven. A torn last line means the provider was still writing, which a frozen source never is.
 */
export async function checkJsonlTranscript(
  path: string,
  describe: string,
  accept: (record: Record<string, unknown>, index: number) => boolean,
  versionOf: (record: Record<string, unknown>) => unknown
): Promise<RelocationTranscriptCheck> {
  let writerVersion: string | null = null
  const stream = createReadStream(path, { encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  let proven = false
  let index = 0
  let lastEndedLine = true
  try {
    for await (const line of lines) {
      if (!line.trim()) {
        continue
      }
      let record: unknown
      try {
        record = JSON.parse(line)
      } catch {
        throw refuseRelocation(
          'not-eligible',
          `Line ${index + 1} of the ${describe} transcript is not a whole record, so its history is incomplete or its format is untested. Nothing was moved.`
        )
      }
      if (!record || typeof record !== 'object' || Array.isArray(record)) {
        throw refuseRelocation(
          'unsupported-capability',
          `The ${describe} transcript holds a record in a format this build has not tested. Nothing was moved.`
        )
      }
      proven = accept(record as Record<string, unknown>, index) || proven
      const version = versionOf(record as Record<string, unknown>)
      if (
        typeof version === 'string' &&
        VERSION.test(version) &&
        (writerVersion === null || (compareProviderVersions(version, writerVersion) ?? 0) > 0)
      ) {
        writerVersion = version.slice(0, 100)
      }
      index += 1
    }
    lastEndedLine = await endsWithNewline(path)
  } catch (error) {
    if (error instanceof SessionRelocationRefusal) {
      throw error
    }
    throw refuseRelocation(
      'not-eligible',
      `The ${describe} transcript could not be read. Nothing was moved.`
    )
  } finally {
    lines.close()
    stream.destroy()
  }
  if (!lastEndedLine) {
    throw refuseRelocation(
      'not-eligible',
      `The ${describe} transcript ends mid-record, so the provider may still be writing it. Nothing was moved.`
    )
  }
  if (!proven) {
    throw refuseRelocation(
      'unsupported-capability',
      `The ${describe} transcript does not identify itself as this conversation in a format this build has tested. Nothing was moved.`
    )
  }
  return { writerVersion }
}

async function endsWithNewline(path: string): Promise<boolean> {
  const handle = await open(path, 'r')
  try {
    const { size } = await handle.stat()
    if (size === 0) {
      return true
    }
    const last = Buffer.alloc(1)
    await handle.read(last, 0, 1, size - 1)
    return last[0] === 0x0a
  } finally {
    await handle.close()
  }
}
