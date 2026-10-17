// The window's side of headless organization: it adopts changes this host committed while no
// window was open, then hands over its current values, which the host imports before admitting
// automation. Only this computer's own window may call these.

import {
  HostOrganizationAdoptedParamsSchema,
  HostOrganizationMigrateParamsSchema,
  SESSION_ORGANIZATION_HOST_RPC
} from '../../../../shared/session-organization-host-schema'
import { getProfileUserDataPath } from '../../../omni-profiles/profile-storage-paths'
import { sessionOrganizationHostFor } from '../../../session-organization/host-organization-instance'
import { runStewardSyncSoon } from '../../../session-organization/steward-sync-main'
import { defineMethod, type RpcMethod } from '../core'
import { assertOrganizationWindowCaller } from './session-organization'

/** Long enough for one steward pass to read the account; the window never waits longer. */
const FRESH_PASS_MS = 5_000

function host() {
  return sessionOrganizationHostFor(getProfileUserDataPath())
}

export const SESSION_ORGANIZATION_HOST_METHODS: RpcMethod[] = [
  defineMethod({
    name: SESSION_ORGANIZATION_HOST_RPC.pending,
    params: null,
    handler: async (_params, context) => {
      assertOrganizationWindowCaller(context)
      if ((await host().pendingAdoption()).length > 0) {
        // Why first: another computer's revocation must be heard before the window adopts.
        await runStewardSyncSoon(getProfileUserDataPath(), FRESH_PASS_MS)
      }
      return { records: await host().pendingAdoption() }
    }
  }),
  defineMethod({
    name: SESSION_ORGANIZATION_HOST_RPC.adopted,
    params: HostOrganizationAdoptedParamsSchema,
    handler: async (params, context) => {
      assertOrganizationWindowCaller(context)
      return host().settleAdoption(params)
    }
  }),
  defineMethod({
    name: SESSION_ORGANIZATION_HOST_RPC.migrate,
    params: HostOrganizationMigrateParamsSchema,
    handler: async (params, context) => {
      assertOrganizationWindowCaller(context)
      const result = await host().migrate(params)
      return {
        imported: result.imported,
        drifted: result.drifted.length,
        personOwned: result.personOwned.length,
        migratedAt: result.migratedAt
      }
    }
  })
]
