import {
  isStewardExecutor,
  organizationTargetKey,
  type OrganizationRecord
} from '../../../shared/session-organization-change'

/** A steward re-title shows the old title under the new one this long. */
export const STEWARD_WAS_TITLE_MS = 24 * 60 * 60 * 1000

/**
 * Session key → the title it had before the steward's re-title, while that re-title is the latest
 * title change and under a day old. `entries` are newest first, as `sessionOrganization.recent`
 * answers.
 */
export function stewardWasTitles(
  entries: readonly OrganizationRecord[],
  now: number
): Record<string, string> {
  const seen = new Set<string>()
  const captions: Record<string, string> = {}
  for (const record of entries) {
    if (record.kind !== 'title' || record.phase !== 'applied') {
      continue
    }
    for (const [index, target] of record.targets.entries()) {
      const key = organizationTargetKey(target)
      if (!key || seen.has(key)) {
        continue
      }
      seen.add(key)
      const before = record.before?.[index]
      if (
        isStewardExecutor(record.executor) &&
        now - Date.parse(record.ts) < STEWARD_WAS_TITLE_MS &&
        typeof before === 'string' &&
        before.trim() &&
        before !== record.value
      ) {
        captions[key] = before
      }
    }
  }
  return captions
}
