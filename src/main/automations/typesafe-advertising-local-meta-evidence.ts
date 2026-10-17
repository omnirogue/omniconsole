import {
  advertisingEvidence,
  advertisingTarget,
  type AdvertisingEvidence,
  type AdvertisingTarget
} from '../../shared/typesafe-advertising'
import { OLDACS_ACCOUNT_ID, OLDACS_COMPANY } from './typesafe-advertising-local-scope'
import {
  createLocalMetaReader,
  type LocalMetaReaderIdentity,
  type LocalMetaReaderOptions
} from './typesafe-advertising-local-meta-transport'
import {
  createLocalMetaControls,
  localMetaBudget,
  localMetaDate,
  readLocalMetaAccount
} from './typesafe-advertising-local-meta-controls'
import {
  localMetaInsightFields,
  parseLocalMetaMetrics
} from './typesafe-advertising-local-meta-metrics'

function validateTargets(targets: readonly AdvertisingTarget[]): AdvertisingTarget[] {
  if (targets.length < 1 || targets.length > 20) {
    throw new Error('Local Meta evidence requires 1 to 20 selected targets.')
  }
  const seen = new Set<string>()
  return targets.map((candidate) => {
    const parsed = advertisingTarget.safeParse(candidate)
    if (
      !parsed.success ||
      parsed.data.company !== OLDACS_COMPANY ||
      parsed.data.accountId !== OLDACS_ACCOUNT_ID ||
      parsed.data.objectType === 'campaign' ||
      seen.has(parsed.data.nativeId)
    ) {
      throw new Error(
        'Local Meta evidence target is outside the authorized unique ad/ad-set scope.'
      )
    }
    seen.add(parsed.data.nativeId)
    return parsed.data
  })
}

export async function fetchLocalMetaEvidence(
  candidates: readonly AdvertisingTarget[],
  identity: LocalMetaReaderIdentity,
  options: LocalMetaReaderOptions = {}
): Promise<AdvertisingEvidence[]> {
  const targets = validateTargets(candidates)
  const reader = createLocalMetaReader(identity, options)
  const now = options.now ?? Date.now
  const account = await readLocalMetaAccount(reader)
  const date = localMetaDate(now(), account.timezone_name)
  const controls = createLocalMetaControls(reader)
  const observed: AdvertisingEvidence[] = []
  for (const target of targets) {
    const native = await controls.readTarget(target)
    const type = target.objectType === 'ad' ? 'ad' : 'adset'
    const response = await reader.list(`${target.nativeId}/insights`, {
      fields: localMetaInsightFields(type),
      date_preset: 'today',
      level: type,
      time_increment: 'all_days',
      limit: '100',
      action_report_time: 'impression',
      use_account_attribution_setting: 'true'
    })
    const projection = parseLocalMetaMetrics(response.rows, target, date)
    const budget = localMetaBudget(native.campaign, native.adset, account.currency)
    observed.push(
      advertisingEvidence.parse({
        source: 'local.meta.graph',
        target,
        name: native.object.name,
        currency: account.currency,
        status: native.object.status,
        effectiveStatus: native.object.effective_status,
        measuredAt: null,
        observation: {
          freshnessBasis: 'completed_native_read',
          collectedAt: response.collectedAt,
          providerComputedAt: null,
          dayFinalized: false,
          attributionFinalized: false
        },
        fetchedAt: response.collectedAt,
        dateStart: date,
        dateStop: date,
        timezone: account.timezone_name,
        leadEvent: projection.leadEvent,
        budgetOwnerId: budget.budgetOwnerId,
        limitations: [
          'Selected native objects only; this is not an account-total report.',
          'Meta attributed revenue is not verified profit or Stripe cash.',
          'Stripe cash, WebinarJam outcomes, and unselected CBO siblings are not observed; this is not full routine optimization evidence.',
          'Insights use impression-time reporting with account attribution settings.',
          'Today is provisional; the reporting day and attribution are not finalized.',
          'The provider computation timestamp and attribution lag are unknown; timestamps record collection only.',
          ...projection.limitations,
          ...budget.limitations
        ],
        metrics: { ...projection.metrics, dailyBudget: budget.dailyBudget }
      })
    )
  }
  await controls.assertUnchanged()
  const latestAccount = await readLocalMetaAccount(reader)
  if (
    JSON.stringify(latestAccount) !== JSON.stringify(account) ||
    localMetaDate(now(), account.timezone_name) !== date ||
    !identity.isCurrent()
  ) {
    throw new Error('Local Meta account, date, or authorized identity changed during observation.')
  }
  await identity.assertCurrent?.()
  const fetchedTime = now()
  if (!identity.isCurrent() || localMetaDate(fetchedTime, account.timezone_name) !== date) {
    throw new Error('Local Meta authorized identity or account date changed after observation.')
  }
  const fetchedAt = new Date(fetchedTime).toISOString()
  return observed.map((evidence) => advertisingEvidence.parse({ ...evidence, fetchedAt }))
}
