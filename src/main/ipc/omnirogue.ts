import type { Store } from '../persistence'
import { registerOmniRogueAccountIpc } from './omnirogue-account-ipc'
import { registerOmniRogueCreditsIpc } from './omnirogue-credits-ipc'
import { registerOmniRogueGatewayIpc } from './omnirogue-gateway-ipc'

export function registerOmniRogueHandlers(store: Store): void {
  registerOmniRogueAccountIpc(store)
  registerOmniRogueCreditsIpc(store)
  registerOmniRogueGatewayIpc(store)
}
