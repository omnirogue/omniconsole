import { BrowserWindow, ipcMain, shell } from 'electron'
import type { OmniRogueCreditBalance } from '../../shared/omnirogue-account'
import { setOmniRogueMcpAccountState } from '../mcp/apply-omnirogue-mcp-env'
import {
  getOmniRogueAccountStatus,
  leaseOmniRogueToken
} from '../omnirogue-account/omnirogue-account-lease'
import type { Store } from '../persistence'
import { cancelUnreadResponseBody } from '../lib/unread-response-body'

const DEFAULT_API_ORIGIN = 'https://api.omnirogue.com'
const DEFAULT_FRONTEND_ORIGIN = 'https://omnirogue.com'
const BALANCE_CACHE_TTL_MS = 30_000
const BALANCE_FETCH_TIMEOUT_MS = 8_000
const DEFAULT_LOW_BALANCE_THRESHOLD = 100

let cachedBalance: OmniRogueCreditBalance | null = null
let cachedAtMs = 0
let inFlightBalanceFetch: Promise<OmniRogueCreditBalance | null> | null = null

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }
  return undefined
}

function toNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

export function parseOmniRogueCreditBalancePayload(
  payload: unknown
): OmniRogueCreditBalance | null {
  if (!payload || typeof payload !== 'object') {
    return null
  }
  const root = payload as Record<string, unknown>
  const wallet =
    root.wallet && typeof root.wallet === 'object'
      ? (root.wallet as Record<string, unknown>)
      : root.data && typeof root.data === 'object'
        ? (root.data as Record<string, unknown>)
        : root
  const user =
    root.user && typeof root.user === 'object' ? (root.user as Record<string, unknown>) : undefined

  const availableCredits =
    toFiniteNumber(wallet.spendableCredits) ??
    toFiniteNumber(wallet.spendable_credits) ??
    toFiniteNumber(wallet.availableCredits) ??
    toFiniteNumber(wallet.available_credits) ??
    toFiniteNumber(wallet.credits) ??
    toFiniteNumber(wallet.balance) ??
    toFiniteNumber(root.spendableCredits) ??
    toFiniteNumber(root.availableCredits) ??
    toFiniteNumber(root.credits) ??
    toFiniteNumber(root.balance)

  if (availableCredits === undefined) {
    return null
  }

  const reservedCredits =
    toFiniteNumber(wallet.reservedCredits) ??
    toFiniteNumber(wallet.reserved_credits) ??
    toFiniteNumber(root.reservedCredits)
  const totalCredits =
    toFiniteNumber(wallet.totalCredits) ??
    toFiniteNumber(wallet.total_credits) ??
    toFiniteNumber(root.totalCredits)
  const lowBalanceThreshold =
    toFiniteNumber(wallet.lowBalanceThreshold) ??
    toFiniteNumber(wallet.low_balance_threshold) ??
    DEFAULT_LOW_BALANCE_THRESHOLD
  const plan =
    toNonEmptyString(wallet.plan) ??
    toNonEmptyString(wallet.tier) ??
    toNonEmptyString(root.plan) ??
    toNonEmptyString(root.tier) ??
    toNonEmptyString(user?.plan) ??
    toNonEmptyString(user?.tier)
  const currency = toNonEmptyString(wallet.currency) ?? toNonEmptyString(root.currency) ?? 'credits'

  return {
    availableCredits,
    ...(reservedCredits !== undefined ? { reservedCredits } : {}),
    ...(totalCredits !== undefined ? { totalCredits } : {}),
    ...(plan ? { plan } : {}),
    currency,
    lowBalanceThreshold,
    updatedAt: new Date().toISOString()
  }
}

function broadcastBalanceChanged(balance: OmniRogueCreditBalance | null): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('omnirogue:credits:balance-changed', balance)
    }
  }
}

async function fetchBalanceFromEndpoint(
  url: string,
  token: string
): Promise<OmniRogueCreditBalance | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), BALANCE_FETCH_TIMEOUT_MS)
  let response: Response | undefined
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json'
      },
      signal: controller.signal
    })
    if (!response.ok) {
      return null
    }
    const data: unknown = await response.json()
    return parseOmniRogueCreditBalancePayload(data)
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
    if (response) {
      await cancelUnreadResponseBody(response)
    }
  }
}

async function fetchLiveOmniRogueBalance(
  forceRefresh: boolean
): Promise<OmniRogueCreditBalance | null> {
  if (!forceRefresh && cachedBalance && Date.now() - cachedAtMs < BALANCE_CACHE_TTL_MS) {
    return cachedBalance
  }
  if (inFlightBalanceFetch) {
    return inFlightBalanceFetch
  }
  const task = (async (): Promise<OmniRogueCreditBalance | null> => {
    const status = await getOmniRogueAccountStatus()
    const apiOrigin = (status.apiOrigin ?? DEFAULT_API_ORIGIN).replace(/\/+$/, '')
    if (status.state !== 'linked') {
      setOmniRogueMcpAccountState({ connected: false, apiOrigin, token: null })
      cachedBalance = null
      cachedAtMs = 0
      broadcastBalanceChanged(null)
      return null
    }
    const token = await leaseOmniRogueToken()
    setOmniRogueMcpAccountState({
      connected: Boolean(token),
      apiOrigin,
      token
    })
    if (!token) {
      cachedBalance = null
      cachedAtMs = 0
      broadcastBalanceChanged(null)
      return null
    }

    const endpoints = [
      `${apiOrigin}/api/omniconsole/wallet`,
      `${apiOrigin}/api/omniconsole/device/me`,
      `${apiOrigin}/api/v1/credits`
    ]
    for (const endpoint of endpoints) {
      const balance = await fetchBalanceFromEndpoint(endpoint, token)
      if (balance) {
        cachedBalance = balance
        cachedAtMs = Date.now()
        broadcastBalanceChanged(balance)
        return balance
      }
    }

    if (cachedBalance) {
      return cachedBalance
    }
    return null
  })().finally(() => {
    if (inFlightBalanceFetch === task) {
      inFlightBalanceFetch = null
    }
  })

  inFlightBalanceFetch = task
  return task
}

export function registerOmniRogueCreditsIpc(_store: Store): void {
  ipcMain.removeHandler('omnirogue:credits:get-balance')
  ipcMain.handle(
    'omnirogue:credits:get-balance',
    async (): Promise<OmniRogueCreditBalance | null> => fetchLiveOmniRogueBalance(false)
  )

  ipcMain.removeHandler('omnirogue:credits:refresh-balance')
  ipcMain.handle(
    'omnirogue:credits:refresh-balance',
    async (): Promise<OmniRogueCreditBalance | null> => fetchLiveOmniRogueBalance(true)
  )

  ipcMain.removeHandler('omnirogue:credits:open-top-up')
  ipcMain.handle('omnirogue:credits:open-top-up', async () => {
    const status = await getOmniRogueAccountStatus().catch(() => null)
    const frontendOrigin = (status?.frontendOrigin ?? DEFAULT_FRONTEND_ORIGIN).replace(/\/+$/, '')
    await shell.openExternal(`${frontendOrigin}/billing`)
  })
}
