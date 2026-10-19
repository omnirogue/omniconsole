import { expect, it, vi } from 'vitest'
import { createOmniCreditsApi } from './omni-credits-api'

it('uses dedicated read channels and removes each push listener', async () => {
  const ipc = { invoke: vi.fn().mockResolvedValue(null), on: vi.fn(), removeListener: vi.fn() }
  const api = createOmniCreditsApi(ipc)
  await api.getWallet()
  await api.refreshWallet()
  await api.claimUpgrade('2026-11-01')
  expect(ipc.invoke.mock.calls).toEqual([
    ['omni:credits:get-wallet'],
    ['omni:credits:refresh-wallet'],
    ['omni:credits:claim-upgrade', '2026-11-01']
  ])
  const wallet = vi.fn()
  const error = vi.fn()
  const offWallet = api.onWalletChanged(wallet)
  const offError = api.onExhausted(error)
  ipc.on.mock.calls[0][1]({}, null)
  ipc.on.mock.calls[1][1]({}, { error: 'credits_exhausted' })
  expect(wallet).toHaveBeenCalledWith(null)
  expect(error).toHaveBeenCalledWith({ error: 'credits_exhausted' })
  offWallet()
  offError()
  expect(ipc.removeListener.mock.calls).toEqual(ipc.on.mock.calls)
})

it('carries reservation identity and display acknowledgment separately', async () => {
  const ipc = { invoke: vi.fn().mockResolvedValue(true), on: vi.fn(), removeListener: vi.fn() }
  const api = createOmniCreditsApi(ipc)
  await api.claimUpgrade('nov', 'reservation')
  await api.finishUpgrade('reservation', false)
  await api.finishUpgrade('reservation', true)
  expect(ipc.invoke.mock.calls).toEqual([
    ['omni:credits:claim-upgrade', 'nov', 'reservation'],
    ['omni:credits:finish-upgrade', 'reservation', false],
    ['omni:credits:finish-upgrade', 'reservation', true]
  ])
})
