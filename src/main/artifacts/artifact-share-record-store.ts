import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ArtifactSessionOrigin } from '../../shared/artifact-session'
import { writeDurableSecureJsonFile, writeSecureJsonFile } from '../../shared/secure-file'
import { getOrcaProfileDirectory } from '../omni-profiles/profile-storage-paths'
import type { ArtifactSourceReview } from './artifact-source-review'
import type { ArtifactReviewSleep } from '../../shared/artifact-review-sleep'
import type { ArtifactReviewAttention } from './artifact-review-attention'

export type ArtifactShareScope = {
  cloudUserId: string
  cloudProfileId: string
  cloudOrganizationId: string
  apiOrigin: string
}

export type ArtifactShareRecord = Omit<ArtifactShareScope, 'cloudOrganizationId'> & {
  cloudOrganizationId?: string
  slug: string
  editToken: string
  shareUrl: string
  expiresAt?: string
  savedAt?: number
  // Why unvalidated here: a malformed origin must not drop the record (and its edit token);
  // readers sanitize it. Absent on records written before sessions were tracked.
  origin?: ArtifactSessionOrigin
  sourceReview?: ArtifactSourceReview
  /** The publishing session's wait for this review; readers validate it (artifact-review-sleep.ts). */
  sleep?: ArtifactReviewSleep
  /** Last canonical attention read; this never authorizes session delivery. */
  reviewAttention?: ArtifactReviewAttention
}

type ArtifactShareRecordFile = {
  version: 2
  lifecycleGeneration: number
  lifecycleNonce: string
  shares: Record<string, ArtifactShareRecord>
}

type ParsedArtifactShareRecordFile = {
  version?: unknown
  lifecycleGeneration?: unknown
  lifecycleNonce?: unknown
  shares?: unknown
}

const MAX_ARTIFACT_SHARE_RECORDS = 10_000

function recordPath(profileId: string, userDataPath: string): string {
  return join(getOrcaProfileDirectory(profileId, userDataPath), 'artifact-shares.json')
}

function isRecord(value: unknown): value is ArtifactShareRecord {
  if (!value || typeof value !== 'object') {
    return false
  }
  const record = value as Partial<ArtifactShareRecord>
  const requiredFieldsValid = [
    record.slug,
    record.editToken,
    record.shareUrl,
    record.cloudUserId,
    record.cloudProfileId,
    record.apiOrigin
  ].every((field) => typeof field === 'string' && field.length > 0)
  const expiresAtValid =
    record.expiresAt === undefined ||
    (typeof record.expiresAt === 'string' && Number.isFinite(Date.parse(record.expiresAt)))
  const savedAtValid =
    record.savedAt === undefined ||
    (typeof record.savedAt === 'number' &&
      Number.isSafeInteger(record.savedAt) &&
      record.savedAt >= 0)
  return requiredFieldsValid && expiresAtValid && savedAtValid
}

function compareRecordsNewestFirst(
  [sourceKeyA, recordA]: [string, ArtifactShareRecord],
  [sourceKeyB, recordB]: [string, ArtifactShareRecord]
): number {
  const savedAtDifference = (recordB.savedAt ?? -1) - (recordA.savedAt ?? -1)
  if (savedAtDifference !== 0) {
    return savedAtDifference
  }
  return sourceKeyA < sourceKeyB ? -1 : sourceKeyA > sourceKeyB ? 1 : 0
}

function pruneRecords(
  shares: Record<string, ArtifactShareRecord>,
  now: number,
  preserveExpired?: { sourceKey: string; slug: string; editToken: string }
): { shares: Record<string, ArtifactShareRecord>; changed: boolean } {
  const currentEntries = Object.entries(shares)
  const unexpired = currentEntries.filter(
    ([sourceKey, record]) =>
      (preserveExpired?.sourceKey === sourceKey &&
        preserveExpired.slug === record.slug &&
        preserveExpired.editToken === record.editToken) ||
      record.expiresAt === undefined ||
      Date.parse(record.expiresAt) > now
  )
  const retained =
    unexpired.length > MAX_ARTIFACT_SHARE_RECORDS
      ? unexpired.sort(compareRecordsNewestFirst).slice(0, MAX_ARTIFACT_SHARE_RECORDS)
      : unexpired
  return {
    shares: Object.fromEntries(retained),
    changed: retained.length !== currentEntries.length
  }
}

function readRecords(
  profileId: string,
  userDataPath: string,
  preserveExpired?: { sourceKey: string; slug: string; editToken: string },
  pruneExpired = true
): ArtifactShareRecordFile {
  const path = recordPath(profileId, userDataPath)
  if (!existsSync(path)) {
    return { version: 2, lifecycleGeneration: 0, lifecycleNonce: '', shares: {} }
  }
  let parsed: ParsedArtifactShareRecordFile
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as ParsedArtifactShareRecordFile
  } catch (error) {
    throw new Error('Artifact share records could not be read safely.', { cause: error })
  }
  if (parsed.version === 1) {
    return { version: 2, lifecycleGeneration: 0, lifecycleNonce: '', shares: {} }
  }
  if (
    parsed.version !== 2 ||
    !parsed.shares ||
    typeof parsed.shares !== 'object' ||
    Array.isArray(parsed.shares)
  ) {
    throw new Error('Artifact share records have an unsupported format.')
  }
  const shareEntries = Object.entries(parsed.shares as Record<string, unknown>)
  const validShares = Object.fromEntries(
    shareEntries.filter((entry): entry is [string, ArtifactShareRecord] => isRecord(entry[1]))
  )
  const pruned = pruneExpired
    ? pruneRecords(validShares, Date.now(), preserveExpired)
    : { shares: validShares, changed: false }
  const records: ArtifactShareRecordFile = {
    version: 2,
    lifecycleGeneration:
      Number.isSafeInteger(parsed.lifecycleGeneration) && Number(parsed.lifecycleGeneration) >= 0
        ? Number(parsed.lifecycleGeneration)
        : 0,
    lifecycleNonce: typeof parsed.lifecycleNonce === 'string' ? parsed.lifecycleNonce : '',
    shares: pruned.shares
  }
  if (pruned.changed || shareEntries.length !== Object.keys(validShares).length) {
    writeSecureJsonFile(path, records)
  }
  return records
}

function matchesScope(record: ArtifactShareRecord, scope: ArtifactShareScope): boolean {
  return (
    matchesScopeIdentity(record, scope) &&
    (record.cloudOrganizationId === undefined ||
      record.cloudOrganizationId === scope.cloudOrganizationId)
  )
}

function matchesScopeIdentity(record: ArtifactShareRecord, scope: ArtifactShareScope): boolean {
  return (
    record.cloudUserId === scope.cloudUserId &&
    record.cloudProfileId === scope.cloudProfileId &&
    record.apiOrigin === scope.apiOrigin
  )
}

export function getArtifactShareRecord(
  profileId: string,
  userDataPath: string,
  sourceKey: string,
  scope: ArtifactShareScope
): ArtifactShareRecord | null {
  const record = readRecords(profileId, userDataPath).shares[sourceKey]
  return record && matchesScope(record, scope) ? record : null
}

/** Every live record the scope can use, keyed by source file. Includes edit tokens: main only. */
export function listArtifactShareRecords(
  profileId: string,
  userDataPath: string,
  scope: ArtifactShareScope
): [string, ArtifactShareRecord][] {
  return Object.entries(readRecords(profileId, userDataPath).shares).filter(([, record]) =>
    matchesScope(record, scope)
  )
}

export function saveArtifactShareRecord(
  profileId: string,
  userDataPath: string,
  sourceKey: string,
  record: ArtifactShareRecord
): void {
  const records = readRecords(profileId, userDataPath)
  records.shares[sourceKey] = { ...record, savedAt: Date.now() }
  records.shares = pruneRecords(records.shares, Date.now()).shares
  writeDurableSecureJsonFile(recordPath(profileId, userDataPath), records)
}

export function refreshArtifactShareRecordExpiration(
  profileId: string,
  userDataPath: string,
  sourceKey: string,
  scope: ArtifactShareScope,
  expected: { slug: string; editToken: string },
  expiresAt: string,
  origin?: ArtifactSessionOrigin,
  sourceReview?: ArtifactSourceReview
): void {
  const records = readRecords(profileId, userDataPath, { sourceKey, ...expected })
  const current = records.shares[sourceKey]
  if (
    !current ||
    !matchesScope(current, scope) ||
    current.slug !== expected.slug ||
    current.editToken !== expected.editToken
  ) {
    return
  }
  records.shares[sourceKey] = {
    ...current,
    cloudOrganizationId: scope.cloudOrganizationId,
    expiresAt,
    savedAt: Date.now(),
    // Why: the latest terminal to publish owns the preview; a write without one keeps the old owner.
    ...(origin ? { origin } : {}),
    sourceReview
  }
  writeSecureJsonFile(recordPath(profileId, userDataPath), records)
}

export function saveArtifactSourceReviewReceipt(
  profileId: string,
  userDataPath: string,
  sourceKey: string,
  scope: ArtifactShareScope,
  expected: { slug: string; sourceReview: ArtifactSourceReview },
  receipt: NonNullable<ArtifactSourceReview['receipt']>
): boolean {
  const records = readRecords(profileId, userDataPath)
  const current = records.shares[sourceKey]
  if (
    !current ||
    !matchesScope(current, scope) ||
    current.slug !== expected.slug ||
    JSON.stringify(current.sourceReview) !== JSON.stringify(expected.sourceReview)
  ) {
    return false
  }
  records.shares[sourceKey] = { ...current, sourceReview: { ...expected.sourceReview, receipt } }
  writeDurableSecureJsonFile(recordPath(profileId, userDataPath), records)
  return true
}

/** One read-modify-write of a record in scope; `change` returns the replacement or null to skip. */
export function updateArtifactShareRecord(
  profileId: string,
  userDataPath: string,
  sourceKey: string,
  scope: ArtifactShareScope,
  change: (record: ArtifactShareRecord) => ArtifactShareRecord | null
): ArtifactShareRecord | null {
  const records = readRecords(profileId, userDataPath)
  const current = records.shares[sourceKey]
  const next = current && matchesScope(current, scope) ? change(current) : null
  if (!next) {
    return null
  }
  records.shares[sourceKey] = next
  writeDurableSecureJsonFile(recordPath(profileId, userDataPath), records)
  return next
}

export function removeArtifactShareRecords(
  profileId: string,
  userDataPath: string,
  scope: ArtifactShareScope,
  match: { sourceKey?: string; slug?: string }
): void {
  const records = readRecords(profileId, userDataPath)
  for (const [sourceKey, record] of Object.entries(records.shares)) {
    if (
      matchesScope(record, scope) &&
      (match.slug === record.slug || (match.slug === undefined && match.sourceKey === sourceKey))
    ) {
      delete records.shares[sourceKey]
    }
  }
  writeDurableSecureJsonFile(recordPath(profileId, userDataPath), records)
}

export function clearArtifactShareRecords(profileId: string, userDataPath: string): void {
  let lifecycleGeneration = 0
  try {
    lifecycleGeneration = readRecords(profileId, userDataPath, undefined, false).lifecycleGeneration
  } catch {
    // Clearing must recover sign-out from an unreadable token index.
  }
  writeDurableSecureJsonFile(recordPath(profileId, userDataPath), {
    version: 2,
    lifecycleGeneration: lifecycleGeneration + 1,
    lifecycleNonce: randomUUID(),
    shares: {}
  })
}

export function captureArtifactShareLifecycle(profileId: string, userDataPath: string): string {
  const records = readRecords(profileId, userDataPath, undefined, false)
  return `${records.lifecycleGeneration}:${records.lifecycleNonce}`
}

export function isArtifactShareLifecycleCurrent(
  profileId: string,
  userDataPath: string,
  lifecycle: string
): boolean {
  return captureArtifactShareLifecycle(profileId, userDataPath) === lifecycle
}
