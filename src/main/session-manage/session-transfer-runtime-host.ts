/**
 * The transfer and relocation handler for this computer's paired runtime, for B's
 * `startSessionHostOwner({ actionHandlers: (owner) => [...] })`: spread its owner context
 * (`actorOf`, `readTurn`, `archive`, `store`) and add `runtime`, `userDataPath` and `providerHome`
 * (`runtimeRelocationProviderHome`). Everything else is this computer's own panes, disks and
 * accounts.
 */

import type { SessionHostRelocationProvider } from '../../shared/session-host-capabilities'
import type { SessionHostAdmissionStore } from '../session-host/session-host-admission-store'
import { RELOCATION_PROVIDER_ADAPTERS } from '../session-relocation/relocation-bundle-import'
import {
  sessionTransferHostActions,
  type SessionTransferHostActions
} from './session-transfer-host-actions'
import { sessionRelocationEnabled } from './session-transfer-relocation-switch'
import {
  runtimeRelocationDestinationHost,
  type RuntimeTransferDestinationWiring
} from './session-transfer-runtime-destination'
import {
  runtimeRelocationSourceHost,
  runtimeTransferSourceHost,
  type RuntimeTransferSourceWiring
} from './session-transfer-runtime-source'

export type RuntimeTransferHostWiring = RuntimeTransferSourceWiring &
  RuntimeTransferDestinationWiring & {
    /** The opened host service's store; read when a step runs, never before. */
    store(): SessionHostAdmissionStore | null
  }

const PROVIDERS = Object.keys(RELOCATION_PROVIDER_ADAPTERS) as SessionHostRelocationProvider[]

export function runtimeSessionTransferHostActions(
  wiring: RuntimeTransferHostWiring
): SessionTransferHostActions {
  return sessionTransferHostActions({
    get store() {
      const store = wiring.store()
      if (!store) {
        throw new Error('This computer’s session host is not open, so no transfer step can run.')
      }
      return store
    },
    relocationEnabled: sessionRelocationEnabled,
    relocationProviders: () => PROVIDERS,
    transferSource: runtimeTransferSourceHost(wiring),
    relocationSource: runtimeRelocationSourceHost(wiring),
    relocationDestination: runtimeRelocationDestinationHost(wiring)
  })
}
