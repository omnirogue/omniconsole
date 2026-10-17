/**
 * The execution host's transfer and relocation steps as one handler for its executor (B's owner
 * service delegates every `transfer.*` / `relocate.*` action here). Capabilities follow what this
 * host can actually carry out: the remote-source transfer when it can give briefs, and relocation
 * per provider only while relocation is on and that provider's tested adapter and CLI are present.
 */

import {
  SESSION_RELOCATION_BUNDLE_CAPABILITY,
  SESSION_RELOCATION_CAPABILITY_BY_PROVIDER,
  SESSION_TRANSFER_REMOTE_SOURCE_CAPABILITY,
  type SessionHostCapability
} from '../../shared/session-host-capabilities'
import type { SessionHostAction } from '../../shared/session-host-protocol'
import { sessionHostRefusal } from '../../shared/session-host-refusal'
import type {
  SessionHostExecutionInput,
  SessionHostPrepared
} from '../session-host/session-host-executor'
import type { SessionHostAdmissionStore } from '../session-host/session-host-admission-store'
import { RELOCATION_PROVIDER_ADAPTERS } from '../session-relocation/relocation-bundle-import'
import type {
  SessionHostActionHandler,
  SessionTransferHostActionDeps
} from './session-transfer-host-action-deps'
import {
  prepareRelocationDestination,
  prepareRelocationResume,
  prepareRelocationStage
} from './session-transfer-relocate-destination'
import {
  prepareRelocationExport,
  prepareRelocationFreeze,
  prepareRelocationRelinquish
} from './session-transfer-relocate-source'
import { prepareTransferSettlement, prepareTransferSource } from './session-transfer-source-steps'

type TransferAction = Extract<SessionHostAction, `transfer.${string}` | `relocate.${string}`>

const STEPS: Record<
  TransferAction,
  (
    deps: SessionTransferHostActionDeps,
    input: SessionHostExecutionInput
  ) => Promise<SessionHostPrepared>
> = {
  'transfer.prepare-source': prepareTransferSource,
  'transfer.settle-source': prepareTransferSettlement,
  'relocate.prepare-destination': prepareRelocationDestination,
  'relocate.freeze-source': prepareRelocationFreeze,
  'relocate.export': prepareRelocationExport,
  'relocate.stage': prepareRelocationStage,
  'relocate.relinquish': prepareRelocationRelinquish,
  'relocate.resume': prepareRelocationResume
}

function isTransferAction(action: SessionHostAction): action is TransferAction {
  return Object.hasOwn(STEPS, action)
}

export type SessionTransferHostActions = SessionHostActionHandler & {
  /** Run by the executor while it holds admission closed after a restart. */
  reconcile(): Promise<void>
}

export function sessionTransferHostActions(
  deps: SessionTransferHostActionDeps
): SessionTransferHostActions {
  return {
    capabilities() {
      const transfer = deps.transferSource ? [SESSION_TRANSFER_REMOTE_SOURCE_CAPABILITY] : []
      const relocation =
        deps.relocationEnabled() && deps.relocationSource && deps.relocationDestination
          ? deps
              .relocationProviders()
              .filter((provider) => RELOCATION_PROVIDER_ADAPTERS[provider])
              .map((provider) => SESSION_RELOCATION_CAPABILITY_BY_PROVIDER[provider])
          : []
      // Why beside them: this build's gate serves the bundle calls a relocation needs.
      const bundle = relocation.length > 0 ? [SESSION_RELOCATION_BUNDLE_CAPABILITY] : []
      return [...transfer, ...relocation, ...bundle] satisfies SessionHostCapability[]
    },
    handles: isTransferAction,
    async prepare(input) {
      const { action } = input.request
      return isTransferAction(action)
        ? await STEPS[action](deps, input)
        : {
            kind: 'refuse',
            refusal: sessionHostRefusal(
              'unsupported-capability',
              `${action} is not a transfer step. Nothing was changed.`
            )
          }
    },
    reconcile: () => reconcileRelocationRelinquish(deps.store)
  }
}

/**
 * A crash between relinquishing and recording it leaves the step `unconfirmed`. The journal itself
 * says which happened: an issued grant under that operation id means it relinquished (and the
 * record gains the grant a retry needs); none means the conversation is still this host's.
 */
export async function reconcileRelocationRelinquish(
  store: SessionHostAdmissionStore
): Promise<void> {
  await store.mutate(async (journal) => {
    let changed = false
    for (const operation of Object.values(journal.operations)) {
      if (operation.action !== 'relocate.relinquish' || operation.state !== 'unconfirmed') {
        continue
      }
      const issued = journal.grants[`issued:${operation.operationId}`]
      Object.assign(
        operation,
        issued
          ? {
              state: 'completed',
              result: {
                relocation: issued.grant.relocation,
                relinquished: true,
                grant: issued.grant
              }
            }
          : {
              state: 'refused',
              refusal: sessionHostRefusal(
                'reconciling',
                'That computer restarted before it handed the conversation over; it still runs it. Nothing was changed.'
              )
            }
      )
      const reservation = journal.reservations[operation.runsUnder ?? operation.operationId]
      if (reservation) {
        reservation.running = undefined
        reservation.state = issued ? 'settled' : 'held'
      }
      changed = true
    }
    return { value: undefined, changed }
  })
}
