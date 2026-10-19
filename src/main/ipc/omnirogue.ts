import type { Store } from '../persistence'
import { registerOmniRogueAccountIpc } from './omnirogue-account-ipc'
import { registerOmniRogueCreditsIpc } from './omnirogue-credits-ipc'
import { registerOmniRogueGatewayHealthIpc } from './omnirogue-gateway-health-ipc'
import { registerOmniRogueGatewayIpc } from './omnirogue-gateway-ipc'
import { registerOmniRogueMcpCatalogIpc } from './omnirogue-mcp-catalog-ipc'
import { registerOmniRogueSpendLedgerIpc } from './omnirogue-spend-ledger-ipc'

export function registerOmniRogueHandlers(store: Store): void {
  registerOmniRogueAccountIpc(store)
  registerOmniRogueCreditsIpc(store)
  registerOmniRogueGatewayIpc(store)
  registerOmniRogueGatewayHealthIpc()
  registerOmniRogueMcpCatalogIpc()
  registerOmniRogueSpendLedgerIpc()
}
