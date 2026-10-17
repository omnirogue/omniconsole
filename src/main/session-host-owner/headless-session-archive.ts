/**
 * A windowless owner's archive placement per pane, for the paired computers that mirror it. The
 * window publishes placement while one is open; with none, the rows it last listed say where each
 * session was, and an archive or unarchive made since (another computer's, the CLI's, the
 * steward's) lands only in the organization ledger, so the newer of the two wins.
 */

import type { SessionArchiveProjection } from '../../shared/session-archive-projection'
import { isStewardExecutor, revisionFieldOf } from '../../shared/session-organization-change'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { sessionOrganizationHostFor } from '../session-organization/host-organization-instance'
import { sessionOrganizationLedgerFor } from '../session-organization/organization-change-ledger'
import type { HostListedRows, HostSessionInventory } from './host-session-inventory'

/** The newest applied archive or unarchive of one session key. */
export type HeadlessArchiveChange = {
  archived: boolean
  /** Epoch ms. */
  at: number
  /** False for the steward's verified-finish archive; a person's or an agent's otherwise. */
  byHand: boolean
}

export function headlessSessionArchives(
  listed: HostListedRows,
  latestChange: (viewKey: string) => HeadlessArchiveChange | undefined
): ReadonlyMap<string, SessionArchiveProjection> {
  const archives = new Map<string, SessionArchiveProjection>()
  for (const row of listed.rows) {
    if (!row.paneKey) {
      continue
    }
    const change = latestChange(row.viewKey)
    const since = change && (listed.listedAt === null || change.at > listed.listedAt)
    archives.set(
      row.paneKey,
      since
        ? { archived: change.archived, byHand: change.archived && change.byHand }
        : { archived: row.archived, byHand: row.archived && row.archivedByHand }
    )
  }
  return archives
}

/**
 * Hands the runtime a reader for its windowless publications, and republishes after each archive
 * or unarchive. Built once per listing and per change: a publication reads it for every pane.
 */
export function publishHeadlessSessionArchives(
  runtime: Pick<
    OrcaRuntimeService,
    'setHeadlessSessionArchiveReader' | 'republishHeadlessSessionArchive'
  >,
  inventory: Pick<HostSessionInventory, 'lastListed'>,
  userDataPath: string
): () => void {
  // Why the host first: its own applied hook folds a change into the values read below, and
  // hooks run in the order they were added.
  const host = sessionOrganizationHostFor(userDataPath)
  const ledger = sessionOrganizationLedgerFor(userDataPath)
  const latestChange = (viewKey: string): HeadlessArchiveChange | undefined => {
    const record = ledger.store.latestFor(viewKey, 'archived')
    const values = record ? host.read([viewKey]).sessions[0]?.values : undefined
    return record && values
      ? {
          archived: values.archived,
          at: Date.parse(record.ts),
          byHand: !isStewardExecutor(record.executor)
        }
      : undefined
  }
  let built: { rows: unknown; archives: ReadonlyMap<string, SessionArchiveProjection> } | null =
    null
  runtime.setHeadlessSessionArchiveReader((paneKey) => {
    const listed = inventory.lastListed()
    if (built?.rows !== listed.rows) {
      built = { rows: listed.rows, archives: headlessSessionArchives(listed, latestChange) }
    }
    return built.archives.get(paneKey)
  })
  const stopHearing = ledger.onApplied((record) => {
    if (revisionFieldOf(record.kind) === 'archived') {
      built = null
      runtime.republishHeadlessSessionArchive()
    }
  })
  return () => {
    stopHearing()
    runtime.setHeadlessSessionArchiveReader(null)
  }
}
