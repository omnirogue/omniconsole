import type { StructuredAgentSessionAcquireInput } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { LaunchLedgerInput } from '../launch-ledger/launch-ledger'
import { attemptLaunchProvenance } from '../launch-ledger/launch-provenance-guard'
import {
  recordStructuredSessionStart,
  recordStructuredSessionStartOutcome
} from '../launch-ledger/structured-session-launch-record'

export function createClaudeStructuredLaunchReceipt(input: StructuredAgentSessionAcquireInput) {
  let receipt: LaunchLedgerInput | null = null
  let failed = false
  return {
    onSpawned: (): void => {
      attemptLaunchProvenance(
        'structured-agent-session',
        () => {
          receipt = recordStructuredSessionStart(input)
          // Spawn confirmation can arrive after a synchronous connection-setup failure.
          if (failed) {
            recordStructuredSessionStartOutcome(receipt, { failed: true })
          }
        },
        undefined
      )
    },
    succeeded: (incarnationId: string | undefined): void => {
      attemptLaunchProvenance(
        'structured-agent-session',
        () => recordStructuredSessionStartOutcome(receipt, { incarnationId }),
        undefined
      )
    },
    failed: (): void => {
      attemptLaunchProvenance(
        'structured-agent-session',
        () => {
          failed = true
          recordStructuredSessionStartOutcome(receipt, { failed: true })
        },
        undefined
      )
    }
  }
}
