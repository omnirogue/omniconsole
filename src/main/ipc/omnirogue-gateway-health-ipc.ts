import { ipcMain } from 'electron'
import { getSharedOmniRogueAccountLease } from '../omnirogue-account/omnirogue-account-lease'
import {
  OmniRogueGatewayHealthPoller,
  type OmniRogueGatewayHealthSnapshot
} from '../omnirogue-account/omnirogue-gateway-health-poller'

export function registerOmniRogueGatewayHealthIpc(
  request: (path: string) => Promise<unknown> = (path) =>
    getSharedOmniRogueAccountLease().request(path)
): OmniRogueGatewayHealthPoller {
  // Never started: the settings card probes on demand, so nothing polls in the background.
  const poller = new OmniRogueGatewayHealthPoller({ request, publish: () => undefined })
  ipcMain.removeHandler('omnirogue:gateway:check-health')
  ipcMain.handle('omnirogue:gateway:check-health', (): Promise<OmniRogueGatewayHealthSnapshot> =>
    poller.checkNow()
  )
  return poller
}
