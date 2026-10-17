import { z } from 'zod'
import type { AdvertisingTarget } from '../../shared/typesafe-advertising'
import { OLDACS_ACCOUNT_ID } from './typesafe-advertising-local-scope'
import type { LocalMetaReader } from './typesafe-advertising-local-meta-transport'

const nativeId = z.string().regex(/^[0-9]{5,30}$/)
const minorBudget = z
  .union([z.number(), z.string().regex(/^\d+$/)])
  .transform(Number)
  .pipe(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER))
  .nullish()
  .transform((value) => value ?? null)
const nativeControl = z.object({
  id: nativeId,
  account_id: nativeId,
  name: z.string().max(1000),
  status: z.enum(['ACTIVE', 'PAUSED']),
  effective_status: z.string().min(1).max(80),
  campaign_id: nativeId.optional(),
  adset_id: nativeId.optional(),
  daily_budget: minorBudget,
  lifetime_budget: minorBudget,
  updated_time: z.string().min(1).max(100).optional()
})
const nativeAccount = z.object({
  id: z.literal(OLDACS_ACCOUNT_ID),
  account_id: z.literal(OLDACS_ACCOUNT_ID.slice(4)),
  currency: z.string().regex(/^[A-Z]{3}$/),
  timezone_name: z.string().min(1).max(100)
})
export type LocalMetaAccount = z.infer<typeof nativeAccount>
type Control = z.infer<typeof nativeControl>
type Node = { type: AdvertisingTarget['objectType']; id: string; control: Control }

export function localMetaDate(now: number, timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(now)
    const value = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((part) => part.type === type)?.value
    const result = `${value('year')}-${value('month')}-${value('day')}`
    if (/^\d{4}-\d{2}-\d{2}$/.test(result)) {
      return result
    }
  } catch {
    // An invalid account timezone cannot define a today observation.
  }
  throw new Error('Local Meta account timezone is unavailable.')
}

export async function readLocalMetaAccount(reader: LocalMetaReader): Promise<LocalMetaAccount> {
  const response = await reader.get(OLDACS_ACCOUNT_ID, {
    fields: 'id,account_id,currency,timezone_name'
  })
  const result = nativeAccount.safeParse(response.value)
  if (!result.success) {
    throw new Error('Local Meta account metadata does not match the authorized account.')
  }
  return result.data
}

function fields(type: Node['type']): string {
  const base = 'id,account_id,name,status,effective_status,updated_time'
  if (type === 'ad') {
    return `${base},campaign_id,adset_id`
  }
  return `${base},daily_budget,lifetime_budget${type === 'adset' ? ',campaign_id' : ''}`
}

async function readControl(reader: LocalMetaReader, type: Node['type'], id: string): Promise<Node> {
  const response = await reader.get(id, { fields: fields(type) })
  const result = nativeControl.safeParse(response.value)
  if (
    !result.success ||
    result.data.id !== id ||
    result.data.account_id !== OLDACS_ACCOUNT_ID.slice(4) ||
    (type !== 'campaign' && !result.data.campaign_id) ||
    (type === 'ad' && !result.data.adset_id)
  ) {
    throw new Error('Local Meta native control or account scope is invalid.')
  }
  return { type, id, control: result.data }
}

export function createLocalMetaControls(reader: LocalMetaReader) {
  const nodes = new Map<string, Node>()
  const read = async (type: Node['type'], id: string): Promise<Control> => {
    const existing = nodes.get(id)
    if (existing && existing.type !== type) {
      throw new Error('Local Meta native IDs overlap different object types.')
    }
    if (existing) {
      return existing.control
    }
    const node = await readControl(reader, type, id)
    nodes.set(id, node)
    return node.control
  }
  return {
    async readTarget(target: AdvertisingTarget) {
      if (target.objectType === 'campaign' || target.adsetId === null) {
        throw new Error('Local Meta evidence only supports selected ads and ad sets.')
      }
      const campaign = await read('campaign', target.campaignId)
      const adset = await read('adset', target.adsetId)
      const object = target.objectType === 'ad' ? await read('ad', target.nativeId) : adset
      if (
        adset.campaign_id !== target.campaignId ||
        object.id !== target.nativeId ||
        object.campaign_id !== target.campaignId ||
        (target.objectType === 'ad' && object.adset_id !== target.adsetId)
      ) {
        throw new Error('Local Meta native hierarchy differs from the selected target.')
      }
      return { object, campaign, adset }
    },
    async assertUnchanged() {
      for (const original of nodes.values()) {
        const latest = await readControl(reader, original.type, original.id)
        if (JSON.stringify(latest) !== JSON.stringify(original)) {
          throw new Error('Local Meta native controls changed while collecting evidence.')
        }
      }
    }
  }
}

export function localMetaBudget(campaign: Control, adset: Control, currency: string) {
  const hasBudget = (control: Control) =>
    (control.daily_budget ?? 0) > 0 || (control.lifetime_budget ?? 0) > 0
  if (hasBudget(campaign) && hasBudget(adset)) {
    throw new Error('Local Meta budget ownership is ambiguous.')
  }
  const owner = hasBudget(campaign) ? campaign : hasBudget(adset) ? adset : null
  const limitations: string[] = []
  if (owner) {
    limitations.push(
      'The owner budget is shared by descendants; selected object budgets are not additive.'
    )
  }
  let dailyBudget: number | null = null
  if (!owner) {
    limitations.push('A native budget owner and daily budget were not reported.')
  } else if (owner.lifetime_budget !== null && owner.lifetime_budget > 0) {
    limitations.push('The native budget owner uses a lifetime budget; no daily budget is inferred.')
  } else if (currency !== 'USD') {
    limitations.push('Daily budget conversion is unavailable for this account currency.')
  } else if (owner.daily_budget !== null && owner.daily_budget > 0) {
    dailyBudget = owner.daily_budget / 100
  }
  return { dailyBudget, budgetOwnerId: owner?.id ?? null, limitations }
}
