import type { IpcRenderer, IpcRendererEvent } from 'electron'
import type { CreditWallet, CreditsExhausted } from '../../shared/omni-credits'

export type OmniCreditsApi = {
  getWallet: () => Promise<CreditWallet | null>
  refreshWallet: () => Promise<CreditWallet | null>
  claimUpgrade: (periodEnd: string, reservationId?: string) => Promise<boolean>
  finishUpgrade: (reservationId: string, shown: boolean) => Promise<void>
  onWalletChanged: (callback: (wallet: CreditWallet | null) => void) => () => void
  onExhausted: (callback: (error: CreditsExhausted) => void) => () => void
}

export function createOmniCreditsApi(
  ipc: Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'>
): OmniCreditsApi {
  function subscribe<T>(channel: string, callback: (payload: T) => void) {
    const listener = (_event: IpcRendererEvent, payload: T) => callback(payload)
    ipc.on(channel, listener)
    return () => {
      ipc.removeListener(channel, listener)
    }
  }
  return {
    getWallet: () => ipc.invoke('omni:credits:get-wallet'),
    refreshWallet: () => ipc.invoke('omni:credits:refresh-wallet'),
    claimUpgrade: (periodEnd, reservationId) =>
      reservationId === undefined
        ? ipc.invoke('omni:credits:claim-upgrade', periodEnd)
        : ipc.invoke('omni:credits:claim-upgrade', periodEnd, reservationId),
    finishUpgrade: (reservationId, shown) =>
      ipc.invoke('omni:credits:finish-upgrade', reservationId, shown),
    onWalletChanged: (callback) => subscribe('omni:credits:wallet-changed', callback),
    onExhausted: (callback) => subscribe('omni:credits:credits_exhausted', callback)
  }
}
