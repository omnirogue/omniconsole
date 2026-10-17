// `sessionOrganization.ownership` and the window's bookkeeping for it: which placements and
// titles are still an agent's own untouched change, the sync stamps their echoes carry, keys a
// pane hands to its provider session, and 1a batch filings seeded as launch-owned. Reading
// answers the window and the local CLI; changing it answers only this computer's window.

import { SESSION_ORGANIZATION_OWNERSHIP_RPC } from '../../../../shared/session-organization-ownership'
import {
  OwnershipMigrateKeysParamsSchema,
  OwnershipSeedParamsSchema,
  OwnershipSnapshotParamsSchema,
  OwnershipSyncStampsParamsSchema
} from '../../../../shared/session-organization-ownership-schema'
import { getProfileUserDataPath } from '../../../omni-profiles/profile-storage-paths'
import { sessionOrganizationLedgerFor } from '../../../session-organization/organization-change-ledger'
import { sessionOrganizationHostFor } from '../../../session-organization/host-organization-instance'
import { defineMethod, type RpcMethod } from '../core'
import {
  assertOrganizationLocalReader,
  assertOrganizationWindowCaller
} from './session-organization'

async function readyStore() {
  const ledger = sessionOrganizationLedgerFor(getProfileUserDataPath())
  // Why wait: replaying the trail at start can still change ownership.
  await ledger.ready
  return ledger.store
}

export const SESSION_ORGANIZATION_OWNERSHIP_METHODS: RpcMethod[] = [
  defineMethod({
    name: SESSION_ORGANIZATION_OWNERSHIP_RPC.snapshot,
    params: OwnershipSnapshotParamsSchema,
    handler: async (params, context) => {
      assertOrganizationLocalReader(context)
      return { keys: (await readyStore()).ownership.snapshot(params.keys) }
    }
  }),
  defineMethod({
    name: SESSION_ORGANIZATION_OWNERSHIP_RPC.syncStamps,
    params: OwnershipSyncStampsParamsSchema,
    handler: async (params, context) => {
      assertOrganizationWindowCaller(context)
      const store = await readyStore()
      const changed = store.updateOwnership((states) => states.attachSyncStamps(params.stamps))
      return { keys: store.ownership.snapshot(changed) }
    }
  }),
  defineMethod({
    name: SESSION_ORGANIZATION_OWNERSHIP_RPC.migrateKeys,
    params: OwnershipMigrateKeysParamsSchema,
    handler: async (params, context) => {
      assertOrganizationWindowCaller(context)
      const store = await readyStore()
      const migrated = params.moves.filter(({ from, to, placementFrom }) =>
        store.migrateKey(from, to, placementFrom)
      )
      // Why: the host's values and published ownership follow the session's key too.
      sessionOrganizationHostFor(getProfileUserDataPath()).noteKeyMoves(migrated)
      return { keys: store.ownership.snapshot(migrated.map(({ to }) => to)) }
    }
  }),
  defineMethod({
    name: SESSION_ORGANIZATION_OWNERSHIP_RPC.seed,
    params: OwnershipSeedParamsSchema,
    handler: async (params, context) => {
      assertOrganizationWindowCaller(context)
      const store = await readyStore()
      const seeded = store.updateOwnership((states) =>
        states.seed(params.seeds, (key) => store.latestFor(key, 'placement') !== undefined)
      )
      sessionOrganizationHostFor(getProfileUserDataPath()).publishOwnership(seeded)
      return { keys: store.ownership.snapshot(seeded) }
    }
  })
]
