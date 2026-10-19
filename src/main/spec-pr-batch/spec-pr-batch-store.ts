import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { SpecPrBatch } from '../../shared/spec-pr-batch'
import { writeDurableSecureJsonFile } from '../../shared/secure-file'
import { ensureActiveOrcaProfile } from '../omni-profiles/profile-index-store'
import {
  getOrcaProfileDirectory,
  getProfileUserDataPath
} from '../omni-profiles/profile-storage-paths'

export function specSourceDigest(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

export function currentSpecPrScope(): { principal: string; directory: string } {
  const userDataPath = getProfileUserDataPath()
  const { profile } = ensureActiveOrcaProfile(userDataPath)
  if (!profile.cloud?.userId) {
    throw new Error('Sign in to OmniConsole before starting a batch.')
  }
  return {
    principal: JSON.stringify([profile.id, profile.cloud.userId, profile.cloud.activeOrgId ?? '']),
    directory: join(getOrcaProfileDirectory(profile.id, userDataPath), 'spec-pr-batches')
  }
}

function batchFile(directory: string, id: string): string {
  return join(directory, `${id}.json`)
}

export function listSpecPrBatches(active: ReadonlySet<string>): SpecPrBatch[] {
  const scope = currentSpecPrScope()
  if (!existsSync(scope.directory)) {
    return []
  }
  return readdirSync(scope.directory)
    .filter((name) => /^spb_[a-f0-9-]{36}\.json$/.test(name))
    .map((name) => {
      try {
        return JSON.parse(readFileSync(join(scope.directory, name), 'utf8')) as SpecPrBatch
      } catch {
        return null
      }
    })
    .filter(
      (batch): batch is SpecPrBatch => batch?.version === 1 && batch.principal === scope.principal
    )
    .map((batch) => {
      if (!active.has(batch.id)) {
        const stranded = batch.slots.filter(
          (slot) => (slot.phase === 'reserved' || slot.phase === 'checking') && !slot.dispatchId
        )
        if (stranded.length) {
          for (const slot of stranded) {
            slot.phase = 'unverifiable'
            slot.reason = 'Batch start was interrupted; inspect the task before another attempt.'
          }
          writeDurableSecureJsonFile(batchFile(scope.directory, batch.id), batch)
        }
      }
      return batch
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export function saveSpecPrBatch(batch: SpecPrBatch): void {
  const scope = currentSpecPrScope()
  if (scope.principal !== batch.principal) {
    throw new Error('The signed-in account changed.')
  }
  const path = batchFile(scope.directory, batch.id)
  if (existsSync(path)) {
    const persisted = JSON.parse(readFileSync(path, 'utf8')) as SpecPrBatch
    batch.stopped ||= persisted.stopped
  }
  batch.updatedAt = new Date().toISOString()
  writeDurableSecureJsonFile(path, batch)
}
