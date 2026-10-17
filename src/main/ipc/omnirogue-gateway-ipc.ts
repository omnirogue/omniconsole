import { BrowserWindow, ipcMain } from 'electron'
import {
  FALLBACK_GATEWAY_MODELS,
  isOmniRogueObpToken,
  normalizePrimaryAiPreference,
  type OmniRogueGatewayModelOption,
  type OmniRogueGatewaySession,
  type PrimaryAiBillingMode
} from '../../shared/omnirogue-account'
import { getSharedOmniRogueAccountLease } from '../omnirogue-account/omnirogue-account-lease'
import { getOmniRogueGatewayModels } from '../omnirogue-account/omnirogue-gateway-models'
import type { Store } from '../persistence'
import {
  OMNIROGUE_GATEWAY_REFRESH_SKEW_MS,
  resolveOmniRogueGatewayBaseUrl,
  resolveOmniRogueOpenAiBaseUrl,
  setOmniRogueGatewayTokenRefresher,
  syncOmniRogueGatewayRuntimeState
} from '../runtime/omnirogue-gateway-env'

const MIN_REFRESH_DELAY_MS = 60_000
const MAX_TIMER_MS = 2_147_483_647

function broadcastGatewaySessionChanged(session: OmniRogueGatewaySession): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('omnirogue:gateway:session-changed', session)
    }
  }
}

function syncMainProcessGatewayEnv(args: {
  billing: PrimaryAiBillingMode
  token: string | null
  baseUrl: string
  model?: string
}): void {
  process.env.OMNIROGUE_BILLING_MODE = args.billing
  process.env.ORCA_OMNIROGUE_BILLING_MODE = args.billing
  process.env.OMNIROGUE_GATEWAY_BASE_URL = args.baseUrl
  if (args.model?.trim()) {
    process.env.OMNIROGUE_MODEL = args.model.trim()
  } else {
    delete process.env.OMNIROGUE_MODEL
  }
  if (args.billing === 'omnirogue-credits' && args.token && isOmniRogueObpToken(args.token)) {
    process.env.ORCA_OMNIROGUE_GATEWAY_TOKEN = args.token
  } else {
    delete process.env.ORCA_OMNIROGUE_GATEWAY_TOKEN
  }
}

export function registerOmniRogueGatewayIpc(store: Store): void {
  const lease = getSharedOmniRogueAccountLease()
  const getModels = () => getOmniRogueGatewayModels((path) => lease.request(path))
  let refreshTimer: ReturnType<typeof setTimeout> | undefined

  // Re-lease just inside the lease's refresh skew so launches never read an expired token.
  const scheduleTokenRefresh = (expiresAt: number | undefined) => {
    clearTimeout(refreshTimer)
    refreshTimer = undefined
    if (expiresAt === undefined) {
      return
    }
    const delay = Math.max(
      expiresAt - OMNIROGUE_GATEWAY_REFRESH_SKEW_MS - Date.now(),
      MIN_REFRESH_DELAY_MS
    )
    refreshTimer = setTimeout(
      () => void syncGatewayToken().catch(() => undefined),
      Math.min(delay, MAX_TIMER_MS)
    )
    refreshTimer.unref?.()
  }

  const syncGatewayToken = async () => {
    const primaryAi = store.getSettings().primaryAi
    const billing: PrimaryAiBillingMode =
      primaryAi?.billing === 'omnirogue-credits' ? 'omnirogue-credits' : 'own-login'
    let apiOrigin: string | undefined
    let expiresAt: number | undefined
    try {
      const accountStatus = await lease.status()
      apiOrigin = accountStatus.apiOrigin
      expiresAt = accountStatus.expiresAt
    } catch {
      // Fall back to default gateway URL when status lookup fails.
    }

    const token = billing === 'omnirogue-credits' ? await lease.leaseToken() : null
    const baseUrl = resolveOmniRogueGatewayBaseUrl(apiOrigin)

    syncOmniRogueGatewayRuntimeState({
      billing,
      agent: primaryAi?.agent,
      model: primaryAi?.model,
      token,
      baseUrl,
      expiresAt
    })
    syncMainProcessGatewayEnv({
      billing,
      token,
      baseUrl,
      model: primaryAi?.model
    })
    scheduleTokenRefresh(token ? expiresAt : undefined)
    return { primaryAi, billing, token, baseUrl, expiresAt }
  }
  setOmniRogueGatewayTokenRefresher(async () => {
    await syncGatewayToken()
  })

  const buildAndSyncSession = async (extras?: {
    switchedInSession?: boolean
    requiresRestartForBillingChange?: boolean
  }): Promise<OmniRogueGatewaySession> => {
    const availableModels = await getModels()
    const { primaryAi, billing, token, baseUrl, expiresAt } = await syncGatewayToken()
    const openAiBaseUrl = resolveOmniRogueOpenAiBaseUrl(baseUrl)

    return {
      active: billing === 'omnirogue-credits' && Boolean(token),
      billing,
      baseUrl,
      openAiBaseUrl,
      agent: primaryAi?.agent,
      model: primaryAi?.model,
      expiresAt,
      tokenAvailable: Boolean(token),
      availableModels,
      ...(extras?.switchedInSession !== undefined
        ? { switchedInSession: extras.switchedInSession }
        : {}),
      ...(extras?.requiresRestartForBillingChange !== undefined
        ? {
            requiresRestartForBillingChange: extras.requiresRestartForBillingChange
          }
        : {})
    }
  }

  void buildAndSyncSession()

  ipcMain.removeHandler('omnirogue:gateway:get-session')
  ipcMain.handle('omnirogue:gateway:get-session', async (): Promise<OmniRogueGatewaySession> => {
    return buildAndSyncSession()
  })

  ipcMain.removeHandler('omnirogue:gateway:list-models')
  ipcMain.handle(
    'omnirogue:gateway:list-models',
    async (): Promise<readonly OmniRogueGatewayModelOption[]> => {
      return (await buildAndSyncSession()).availableModels ?? FALLBACK_GATEWAY_MODELS
    }
  )

  ipcMain.removeHandler('omnirogue:gateway:set-billing-mode')
  ipcMain.handle(
    'omnirogue:gateway:set-billing-mode',
    async (_event, rawArgs: unknown): Promise<OmniRogueGatewaySession> => {
      const current = store.getSettings().primaryAi
      const previousBilling: PrimaryAiBillingMode =
        current?.billing === 'omnirogue-credits' ? 'omnirogue-credits' : 'own-login'
      const args = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as Record<
        string,
        unknown
      >
      const next = normalizePrimaryAiPreference({
        agent: args.agent ?? current?.agent ?? 'claude',
        model: args.model ?? current?.model,
        billing: args.billing
      })
      if (next) {
        store.updateSettings({ primaryAi: next }, { notifyListeners: true })
      }
      const session = await buildAndSyncSession({
        requiresRestartForBillingChange: Boolean(next && next.billing !== previousBilling)
      })
      broadcastGatewaySessionChanged(session)
      return session
    }
  )

  ipcMain.removeHandler('omnirogue:gateway:switch-model')
  ipcMain.handle(
    'omnirogue:gateway:switch-model',
    async (_event, rawArgs: unknown): Promise<OmniRogueGatewaySession> => {
      const current = store.getSettings().primaryAi
      const previousBilling: PrimaryAiBillingMode =
        current?.billing === 'omnirogue-credits' ? 'omnirogue-credits' : 'own-login'
      const args = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as Record<
        string,
        unknown
      >
      const next = normalizePrimaryAiPreference({
        agent: args.agent ?? current?.agent ?? 'claude',
        model: args.model,
        billing: args.billing ?? current?.billing ?? 'own-login'
      })
      if (next) {
        store.updateSettings({ primaryAi: next }, { notifyListeners: true })
      }
      const hasPtyId = typeof args.ptyId === 'string' && args.ptyId.trim().length > 0
      const session = await buildAndSyncSession({
        switchedInSession: Boolean(hasPtyId && next?.model),
        requiresRestartForBillingChange: Boolean(next && next.billing !== previousBilling)
      })
      broadcastGatewaySessionChanged(session)
      return session
    }
  )
}
