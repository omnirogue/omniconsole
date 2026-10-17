/**
 * The host values' catch-up from history at start. The durable deleted value is a fold of the
 * window's `delete` records (session parity, F4); a build before it moved `appliedThrough` past
 * every `delete` without folding it, and rewrites host-values.json without the `deletedThrough`
 * watermark only folding builds write. So before the usual replay from `appliedThrough`, the
 * retained `delete` history older than that and newer than the watermark — all of it when the
 * watermark is absent (a first start after an upgrade, or after an older build ran) — is folded
 * too. Per-field stamps keep a refold idempotent and never let an older record undo a newer value,
 * such as a mark the window seeded.
 */

import type { OrganizationRecord } from '../../shared/session-organization-change'
import type { HostOrganizationView } from './host-organization-view'
import type { OrganizationHistoryStore } from './organization-history-store'

type CatchUpView = Pick<
  HostOrganizationView,
  'appliedThrough' | 'deletedThrough' | 'fold' | 'markDeletesFolded'
>

export function foldRetainedDeletes(
  store: Pick<OrganizationHistoryStore, 'recent'>,
  view: Pick<HostOrganizationView, 'deletedThrough' | 'fold'>,
  appliedSinceMs: number
): void {
  const watermark = view.deletedThrough ? Date.parse(view.deletedThrough) : Number.NaN
  const since = Number.isFinite(watermark) ? watermark : 0
  if (since >= appliedSinceMs) {
    return
  }
  const deletes = store.recent({ since, kinds: ['delete'], limit: Number.MAX_SAFE_INTEGER })
  for (const record of deletes.toReversed()) {
    // Why only older ones: the replay from `appliedThrough` folds the rest.
    if (Date.parse(record.ts) < appliedSinceMs) {
      view.fold(record)
    }
  }
}

/** Every applied record since `appliedThrough` to `heard`, after the deletes an older build passed. */
export function replayHostOrganizationHistory(
  store: Pick<OrganizationHistoryStore, 'recent'>,
  view: CatchUpView,
  heard: (record: OrganizationRecord) => void
): void {
  const since = view.appliedThrough ? Date.parse(view.appliedThrough) : 0
  foldRetainedDeletes(store, view, since)
  for (const record of store.recent({ since, limit: Number.MAX_SAFE_INTEGER }).toReversed()) {
    heard(record)
  }
  view.markDeletesFolded()
}
