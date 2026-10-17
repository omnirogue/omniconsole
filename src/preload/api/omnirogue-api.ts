import type { IpcRenderer, IpcRendererEvent } from 'electron'
import type {
  OmniRogueAccountState,
  OmniRogueCreditBalance,
  OmniRogueGatewayModelOption,
  OmniRogueGatewaySession,
  PrimaryAiBillingMode
} from '../../shared/omnirogue-account'
import type { TuiAgent } from '../../shared/tui-agent'

// Structural copy of main's OmniRogueDoctorResult; preload/api is in the renderer type graph.
export type OmniRogueDoctorCheck = {
  id: string
  label: string
  status: 'pass' | 'warn' | 'fail' | 'skipped'
  latencyMs: number
  message: string
  remediation?: 'reconnect' | 'top-up' | 'retry'
  checks?: OmniRogueDoctorCheck[]
}
export type OmniRogueDoctorReport = {
  checkedAt: string
  billingMode: PrimaryAiBillingMode
  status: OmniRogueDoctorCheck['status']
  stages: OmniRogueDoctorCheck[]
}

export type OmniRogueAccountApi = {
  status: () => Promise<OmniRogueAccountState>
  getStatus: () => Promise<OmniRogueAccountState>
  link: () => Promise<OmniRogueAccountState>
  startConnect: () => Promise<OmniRogueAccountState>
  unlink: () => Promise<OmniRogueAccountState>
  disconnect: () => Promise<OmniRogueAccountState>
  openSignup: () => Promise<{ url: string }>
  acceptCallback: (rawUrl: string) => Promise<OmniRogueAccountState>
  runDoctor: () => Promise<OmniRogueDoctorReport>
  onStatusChanged: (callback: (state: OmniRogueAccountState) => void) => () => void
}

export type OmniRogueCreditsApi = {
  getBalance: () => Promise<OmniRogueCreditBalance | null>
  refreshBalance: () => Promise<OmniRogueCreditBalance | null>
  openTopUp: () => Promise<void>
  onBalanceChanged: (callback: (balance: OmniRogueCreditBalance | null) => void) => () => void
}

export type OmniRogueGatewayApi = {
  getSession: () => Promise<OmniRogueGatewaySession>
  listModels: () => Promise<readonly OmniRogueGatewayModelOption[]>
  setBillingMode: (args: {
    billing: PrimaryAiBillingMode
    agent?: TuiAgent
    model?: string
  }) => Promise<OmniRogueGatewaySession>
  switchModel: (args: {
    agent: TuiAgent
    model?: string
    billing?: PrimaryAiBillingMode
    ptyId?: string
  }) => Promise<OmniRogueGatewaySession>
  onSessionChanged: (callback: (session: OmniRogueGatewaySession) => void) => () => void
}

export type OmniRogueApi = {
  account: OmniRogueAccountApi
  credits: OmniRogueCreditsApi
  gateway: OmniRogueGatewayApi
}

export function createOmniRogueApi(
  ipcRenderer: Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'>
): OmniRogueApi {
  return {
    account: {
      status: () => ipcRenderer.invoke('omnirogue:account:status'),
      getStatus: () => ipcRenderer.invoke('omnirogue:account:get-status'),
      link: () => ipcRenderer.invoke('omnirogue:account:link'),
      startConnect: () => ipcRenderer.invoke('omnirogue:account:start-connect'),
      unlink: () => ipcRenderer.invoke('omnirogue:account:unlink'),
      disconnect: () => ipcRenderer.invoke('omnirogue:account:disconnect'),
      openSignup: () => ipcRenderer.invoke('omnirogue:account:open-signup'),
      acceptCallback: (rawUrl) => ipcRenderer.invoke('omnirogue:account:accept-callback', rawUrl),
      runDoctor: () => ipcRenderer.invoke('omnirogue:account:runDoctor'),
      onStatusChanged: (callback) => {
        const listener = (_event: IpcRendererEvent, state: OmniRogueAccountState): void => {
          callback(state)
        }
        ipcRenderer.on('omnirogue:account:status-changed', listener)
        return () => {
          ipcRenderer.removeListener('omnirogue:account:status-changed', listener)
        }
      }
    },

    credits: {
      getBalance: () => ipcRenderer.invoke('omnirogue:credits:get-balance'),
      refreshBalance: () => ipcRenderer.invoke('omnirogue:credits:refresh-balance'),
      openTopUp: () => ipcRenderer.invoke('omnirogue:credits:open-top-up'),
      onBalanceChanged: (callback) => {
        const listener = (
          _event: IpcRendererEvent,
          balance: OmniRogueCreditBalance | null
        ): void => {
          callback(balance)
        }
        ipcRenderer.on('omnirogue:credits:balance-changed', listener)
        return () => {
          ipcRenderer.removeListener('omnirogue:credits:balance-changed', listener)
        }
      }
    },
    gateway: {
      getSession: () => ipcRenderer.invoke('omnirogue:gateway:get-session'),
      listModels: () => ipcRenderer.invoke('omnirogue:gateway:list-models'),
      setBillingMode: (args) => ipcRenderer.invoke('omnirogue:gateway:set-billing-mode', args),
      switchModel: (args) => ipcRenderer.invoke('omnirogue:gateway:switch-model', args),
      onSessionChanged: (callback) => {
        const listener = (_event: IpcRendererEvent, session: OmniRogueGatewaySession): void => {
          callback(session)
        }
        ipcRenderer.on('omnirogue:gateway:session-changed', listener)
        return () => {
          ipcRenderer.removeListener('omnirogue:gateway:session-changed', listener)
        }
      }
    }
  }
}
