import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  advertisingTarget,
  advertisingRoutinePolicy,
  type AdvertisingEvidence,
  type AdvertisingRoutinePolicy,
  type AdvertisingTarget
} from '../../shared/typesafe-advertising'
import { fetchCoordinatorAdvertisingEvidence } from './typesafe-advertising-coordinator'
import { authorizeLocalMetaRead } from './local-meta-read-authority'
import { fetchLocalMetaEvidence } from './typesafe-advertising-local-meta-evidence'
import {
  OLDACS_ACCOUNT_ID,
  type AdvertisingEvidenceScope
} from './typesafe-advertising-local-scope'

export function advertisingDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function advertisingEvidenceRevision(evidence: AdvertisingEvidence): string {
  const { measuredAt: _measuredAt, fetchedAt: _fetchedAt, observation, ...facts } = evidence
  if (!observation) {
    return advertisingDigest(facts)
  }
  const { collectedAt: _collectedAt, ...basis } = observation
  return advertisingDigest({ ...facts, observation: basis })
}

function assertAllowedObjectTypes(
  targets: readonly AdvertisingTarget[],
  policy?: Pick<AdvertisingRoutinePolicy, 'allowedObjectTypes'>
): void {
  const allowed = advertisingRoutinePolicy.shape.allowedObjectTypes.parse(
    policy?.allowedObjectTypes
  )
  if (targets.some((target) => !allowed.includes(target.objectType))) {
    throw new Error('This run contains targets outside its configured advertising object types.')
  }
}

export function readAdvertisingCandidates(
  content: string,
  policy?: Pick<AdvertisingRoutinePolicy, 'allowedObjectTypes'>
): AdvertisingTarget[] {
  const matches = [...content.matchAll(/^```omni-advertising-candidates\s*\n([\s\S]*?)^```\s*$/gm)]
  if (matches.length !== 1 || content.length > 256_000) {
    throw new Error('This run needs one complete advertising target block from source data.')
  }
  let raw: unknown
  try {
    raw = JSON.parse(matches[0][1])
  } catch {
    throw new Error('The advertising target block is not valid JSON.')
  }
  const parsed = z.array(advertisingTarget).min(1).max(20).safeParse(raw)
  if (!parsed.success) {
    throw new Error('The advertising target identities are incomplete or invalid.')
  }
  const identities = parsed.data.map((target) => `${target.objectType}:${target.nativeId}`)
  if (new Set(identities).size !== identities.length) {
    throw new Error('The advertising target block repeats an object.')
  }
  assertAllowedObjectTypes(parsed.data, policy)
  return parsed.data
}

function currentDate(timezone: string, now: number): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(now)
  const part = (kind: string) => parts.find((value) => value.type === kind)?.value
  return `${part('year')}-${part('month')}-${part('day')}`
}

export function assertAdvertisingEvidenceFresh(
  evidence: AdvertisingEvidence,
  policy: AdvertisingRoutinePolicy,
  now = Date.now()
): void {
  assertAllowedObjectTypes([evidence.target], policy)
  const age = policy.maxEvidenceAgeSeconds * 1000
  const freshnessAt =
    evidence.source === 'local.meta.graph' ? evidence.observation?.collectedAt : evidence.measuredAt
  if (
    [freshnessAt, evidence.fetchedAt].some((stamp) => {
      if (!stamp) {
        return true
      }
      const time = Date.parse(stamp)
      return !Number.isFinite(time) || time > now + 30_000 || now - time > age
    })
  ) {
    throw new Error('Advertising evidence is stale; refresh this recommendation.')
  }
  if (
    evidence.dateStart !== currentDate(evidence.timezone, now) ||
    evidence.dateStop !== evidence.dateStart
  ) {
    throw new Error('Advertising evidence does not cover today in the account timezone.')
  }
  if (
    evidence.target.company !== policy.company ||
    evidence.target.accountId !== policy.accountId
  ) {
    throw new Error('The advertising evidence belongs to another company or account.')
  }
}

export async function fetchAdvertisingEvidence(
  targets: readonly AdvertisingTarget[],
  policy: AdvertisingRoutinePolicy,
  now?: number,
  scope?: AdvertisingEvidenceScope
): Promise<AdvertisingEvidence[]> {
  assertAllowedObjectTypes(targets, policy)
  if (
    targets.some(
      (target) => target.company !== policy.company || target.accountId !== policy.accountId
    )
  ) {
    throw new Error('This run contains targets outside its configured company and account.')
  }
  let evidence: AdvertisingEvidence[]
  if (policy.accountId === OLDACS_ACCOUNT_ID) {
    if (!scope) {
      throw new Error('Local advertising evidence requires its bound routine execution scope.')
    }
    const authority = await authorizeLocalMetaRead(scope, policy)
    evidence = await fetchLocalMetaEvidence(targets, authority, {
      now: now === undefined ? Date.now : () => now
    })
    await authority.assertCurrent()
  } else {
    evidence = await fetchCoordinatorAdvertisingEvidence(targets, policy, now)
  }
  for (const item of evidence) {
    assertAdvertisingEvidenceFresh(item, policy, now ?? Date.now())
  }
  return evidence
}
