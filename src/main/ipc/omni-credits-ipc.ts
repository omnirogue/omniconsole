import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import { parseCreditWallet, type CreditWallet } from '../../shared/omni-credits'
import { currentConsolePublicationScope } from '../backoffice/console-workflow-person'
import {
  onConsoleCreditsExhausted,
  requestConsoleWorkflow
} from '../backoffice/console-workflow-transport'
import type { Store } from '../persistence'
import { subscribeCloudSessionMutations } from '../omni-profiles/profile-cloud-session-mutation'

let stopIdentityListener: (() => void) | undefined
let stopExhaustedListener: (() => void) | undefined

export function registerOmniCreditsIpc(store: Store): void {
  let cached: CreditWallet | null = null
  let cachedAt = 0
  let cacheScope: string | null = null
  let inFlight: { scope: string; task: Promise<CreditWallet | null> } | null = null
  const shownPeriods = new Set<string>()
  const reservations = new Map<string, { scope: string; period: string; senderId: number }>()
  const observedSenders = new WeakSet<IpcMainInvokeEvent['sender']>()
  let knownPeriod = ''
  let identityRevision = 0
  const enabled = () => store.getSettings().experimentalOmniCredits === true
  const scope = () => {
    const identity = enabled() ? currentConsolePublicationScope() : null
    const key = identity ? JSON.stringify([identity, identityRevision]) : null
    if (cacheScope !== key) {
      const hadScope = cacheScope !== null
      cached = null
      cachedAt = 0
      cacheScope = key
      inFlight = null
      knownPeriod = ''
      shownPeriods.clear()
      reservations.clear()
      if (hadScope) {
        publish('omni:credits:wallet-changed', null)
      }
    }
    return key
  }
  const reconcilePeriod = (period: string) => {
    if (period) {
      if (shownPeriods.delete('')) {
        shownPeriods.add(period)
      }
      for (const reservation of reservations.values()) {
        if (!reservation.period) {
          reservation.period = period
        }
      }
      knownPeriod = period
    }
    return period || knownPeriod
  }
  const publish = (channel: string, payload: unknown) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, payload)
      }
    }
  }
  async function getWallet(force: boolean): Promise<CreditWallet | null> {
    const key = scope()
    if (!key || key === 'null') {
      return null
    }
    if (!force && cachedAt && Date.now() - cachedAt < 30_000) {
      return cached
    }
    if (inFlight?.scope === key) {
      return inFlight.task
    }
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 8_000)
    const task = requestConsoleWorkflow(
      '/api/credits',
      'GET',
      z.unknown(),
      undefined,
      8_000,
      false,
      undefined,
      () => scope() === key,
      controller.signal
    )
      .then((result) => {
        if (scope() !== key) {
          return null
        }
        cached = result.ok ? parseCreditWallet(result.data) : null
        reconcilePeriod(cached?.period?.end ?? '')
        cachedAt = Date.now()
        publish('omni:credits:wallet-changed', cached)
        return cached
      })
      .catch(() => {
        if (scope() === key) {
          cached = null
          cachedAt = Date.now()
          publish('omni:credits:wallet-changed', null)
        }
        return null
      })
      .finally(() => {
        clearTimeout(timeout)
        if (inFlight?.task === task) {
          inFlight = null
        }
      })
    inFlight = { scope: key, task }
    return task
  }
  // Only the renderer's post-render acknowledgment consumes a period.
  const claimUpgrade = (event: IpcMainInvokeEvent, period: unknown, id?: unknown) => {
    const key = scope()
    if (!key || typeof period !== 'string' || period.length > 128) {
      return false
    }
    const normalized = reconcilePeriod(period)
    if (shownPeriods.has(normalized)) {
      return false
    }
    if (id === undefined) {
      return true
    }
    if (typeof id !== 'string' || !id || id.length > 128) {
      return false
    }
    if ([...reservations.values()].some((item) => item.period === normalized)) {
      return false
    }
    reservations.set(id, { scope: key, period: normalized, senderId: event.sender.id })
    if (!observedSenders.has(event.sender)) {
      observedSenders.add(event.sender)
      event.sender.once('destroyed', () => {
        for (const [token, item] of reservations) {
          if (item.senderId === event.sender.id) {
            reservations.delete(token)
          }
        }
      })
    }
    return true
  }
  const finishUpgrade = (event: IpcMainInvokeEvent, id: unknown, shown: unknown) => {
    const key = scope()
    if (typeof id !== 'string' || typeof shown !== 'boolean') {
      return
    }
    const reservation = reservations.get(id)
    if (!reservation || reservation.scope !== key || reservation.senderId !== event.sender.id) {
      return
    }
    reservations.delete(id)
    if (shown) {
      shownPeriods.add(reconcilePeriod(reservation.period))
    }
  }
  for (const [channel, handler] of [
    ['omni:credits:get-wallet', () => getWallet(false)],
    ['omni:credits:refresh-wallet', () => getWallet(true)],
    ['omni:credits:claim-upgrade', claimUpgrade],
    ['omni:credits:finish-upgrade', finishUpgrade]
  ] as const) {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, handler)
  }
  stopIdentityListener?.()
  stopIdentityListener = subscribeCloudSessionMutations(() => {
    identityRevision += 1
    scope()
  })
  stopExhaustedListener?.()
  stopExhaustedListener = onConsoleCreditsExhausted((error) => {
    if (enabled()) {
      publish('omni:credits:credits_exhausted', error)
    }
  })
}
