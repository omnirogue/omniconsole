import {
  localAdvertisingActionSnapshot,
  type LocalAdvertisingActionSnapshot
} from '../../shared/advertising-action-provider-contract'
import type { AdvertisingTarget } from '../../shared/typesafe-advertising'
import { advertisingDigest } from './typesafe-advertising-evidence'
import {
  createLocalMetaControls,
  localMetaBudget,
  readLocalMetaAccount
} from './typesafe-advertising-local-meta-controls'
import {
  createLocalMetaReader,
  type LocalMetaReader,
  type LocalMetaReaderIdentity,
  type LocalMetaReaderOptions
} from './typesafe-advertising-local-meta-transport'

type NativeControls = Awaited<ReturnType<ReturnType<typeof createLocalMetaControls>['readTarget']>>
export type LocalMetaStatusObservation = {
  snapshot: LocalAdvertisingActionSnapshot
  version: string
  dailyBudget: number | null
  timezone: string
  observedAt: string
}

function ancestor(
  control: NativeControls['campaign'],
  level: 'campaign' | 'adset',
  accountId: string
): LocalAdvertisingActionSnapshot['ancestors'][number] {
  return {
    objectId: control.id,
    adAccountId: accountId,
    level,
    parentId: level === 'campaign' ? null : (control.campaign_id ?? null),
    campaignId: level === 'campaign' ? null : (control.campaign_id ?? null),
    status: control.status,
    effectiveStatus: control.effective_status,
    dailyBudget: control.daily_budget,
    lifetimeBudget: control.lifetime_budget
  }
}

async function readSnapshot(reader: LocalMetaReader, target: AdvertisingTarget) {
  const account = await readLocalMetaAccount(reader)
  const controls = createLocalMetaControls(reader)
  const native = await controls.readTarget(target)
  const budget = localMetaBudget(native.campaign, native.adset, account.currency)
  const snapshot = localAdvertisingActionSnapshot.parse({
    id: `local.meta.graph:${target.objectType}:${target.nativeId}`,
    objectId: native.object.id,
    adAccountId: account.id,
    level: target.objectType,
    parentId: target.objectType === 'ad' ? target.adsetId : target.campaignId,
    campaignId: target.campaignId,
    status: native.object.status,
    effectiveStatus: native.object.effective_status,
    dailyBudget: native.object.daily_budget,
    lifetimeBudget: native.object.lifetime_budget,
    currency: account.currency,
    budgetOwnerId: budget.budgetOwnerId,
    ancestors: [
      ancestor(native.campaign, 'campaign', account.id),
      ...(target.objectType === 'ad' ? [ancestor(native.adset, 'adset', account.id)] : [])
    ]
  })
  return { snapshot, dailyBudget: budget.dailyBudget, timezone: account.timezone_name }
}

/** Names and provider timestamps are not native mutation preconditions. */
export async function readLocalMetaStatus(
  target: AdvertisingTarget,
  identity: LocalMetaReaderIdentity,
  options: LocalMetaReaderOptions = {}
): Promise<LocalMetaStatusObservation> {
  const reader = createLocalMetaReader(identity, options)
  const initial = await readSnapshot(reader, target)
  const latest = await readSnapshot(reader, target)
  if (advertisingDigest(initial) !== advertisingDigest(latest)) {
    throw new Error('Local Meta native controls changed during the independent read.')
  }
  await identity.assertCurrent?.()
  if (!identity.isCurrent()) {
    throw new Error('Local Meta action authority changed during the independent read.')
  }
  return {
    ...latest,
    version: advertisingDigest(latest.snapshot),
    observedAt: new Date((options.now ?? Date.now)()).toISOString()
  }
}

export function localMetaStatusMatches(
  expected: LocalAdvertisingActionSnapshot,
  observed: LocalAdvertisingActionSnapshot,
  status: 'ACTIVE' | 'PAUSED'
): boolean {
  // Effective delivery can differ from configured ACTIVE due to native parent or review state.
  return (
    observed.status === status &&
    advertisingDigest({
      ...observed,
      status: expected.status,
      effectiveStatus: expected.effectiveStatus
    }) === advertisingDigest(expected)
  )
}
