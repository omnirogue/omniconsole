// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  parseCreditWallet,
  creditsExhaustedSchema,
  type CreditWallet,
  type CreditsExhausted
} from '../../../../shared/omni-credits'
import { OmniCreditsPill } from './OmniCreditsPill'
const state = { settings: { experimentalOmniCredits: true } }
vi.mock('@/store', () => ({
  useAppStore: (selector: (value: typeof state) => unknown) => selector(state)
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    fallback.replace(/\{\{(\w+)(?:, number)?\}\}/g, (_match, key: string) =>
      typeof values?.[key] === 'number' ? values[key].toLocaleString() : String(values?.[key] ?? '')
    )
}))
let walletListener: (wallet: CreditWallet | null) => void
let exhaustedListener: (error: CreditsExhausted) => void
const getWallet = vi.fn()
const claimUpgrade = vi.fn()
const offWallet = vi.fn()
const offError = vi.fn()
const wallet = (extra: Record<string, unknown> = {}) =>
  parseCreditWallet({
    enabled: true,
    balance: 12345,
    period: { end: '2026-11-01T00:00:00Z' },
    you: { actor: 'sal', name: 'Sal', spent: 1200 },
    ...extra
  })
beforeEach(() => {
  state.settings.experimentalOmniCredits = true
  getWallet.mockReset().mockResolvedValue(wallet())
  const shown = new Set<string>()
  claimUpgrade.mockReset().mockImplementation(async (key: string) => {
    if (shown.has(key)) {
      return false
    }
    shown.add(key)
    return true
  })
  offWallet.mockClear()
  offError.mockClear()
  Object.assign(window, {
    api: {
      omniCredits: {
        getWallet,
        claimUpgrade,
        onWalletChanged: (fn: typeof walletListener) => {
          walletListener = fn
          return offWallet
        },
        onExhausted: (fn: typeof exhaustedListener) => {
          exhaustedListener = fn
          return offError
        }
      },
      shell: { openUrl: vi.fn().mockResolvedValue(undefined) }
    }
  })
})
afterEach(cleanup)
describe('OmniOS team credits pill', () => {
  it('makes no request or subscription while the experimental setting is off', () => {
    state.settings.experimentalOmniCredits = false
    render(<OmniCreditsPill />)
    expect(screen.queryByTestId('omni-credits-pill')).toBeNull()
    expect(getWallet).not.toHaveBeenCalled()
  })
  it.each([null, { enabled: false, balance: 1 }])(
    'stays invisible for an unavailable/disabled wallet',
    async (value) => {
      getWallet.mockResolvedValue(value)
      render(<OmniCreditsPill />)
      await waitFor(() => expect(getWallet).toHaveBeenCalled())
      expect(screen.queryByTestId('omni-credits-pill')).toBeNull()
    }
  )
  it('shows balance, own usage, refill date and the authorized member table', async () => {
    getWallet.mockResolvedValue(
      wallet({
        members: [
          { actor: 'sal', name: 'Sal', spent: 1200 },
          { actor: 'uma', name: 'Uma', spent: 1955 }
        ]
      })
    )
    render(<OmniCreditsPill />)
    fireEvent.click(await screen.findByTestId('omni-credits-pill'))
    expect(await screen.findByText('You used 1,200 credits this month')).toBeVisible()
    expect(screen.getByText('Uma')).toBeVisible()
    expect(screen.getByText('1,955')).toBeVisible()
    expect(screen.getByText(/Refills on/)).toBeVisible()
  })
  it('keeps the member table absent for a member wallet, and supports icon-only mode', async () => {
    render(<OmniCreditsPill iconOnly />)
    const pill = await screen.findByTestId('omni-credits-pill')
    expect(pill).toHaveAccessibleName('OmniOS team: 12,345 credits')
    expect(pill.textContent).toBe('')
    fireEvent.click(pill)
    expect(screen.queryByRole('table')).toBeNull()
  })
  it('opens on exhaustion once per period even across remounts, and again in a new period', async () => {
    getWallet.mockResolvedValue(wallet({ balance: 0 }))
    const first = render(<OmniCreditsPill />)
    expect(await screen.findByRole('dialog')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    first.unmount()
    render(<OmniCreditsPill />)
    await screen.findByTestId('omni-credits-pill')
    expect(screen.queryByRole('dialog')).toBeNull()
    await act(async () =>
      walletListener(wallet({ balance: 0, period: { end: '2026-12-01T00:00:00Z' } }))
    )
    expect(await screen.findByRole('dialog')).toBeVisible()
  })
  it('opens on a main-pushed insufficient-credit error even with a positive balance', async () => {
    render(<OmniCreditsPill />)
    await screen.findByTestId('omni-credits-pill')
    await act(async () =>
      exhaustedListener(
        creditsExhaustedSchema.parse({
          error: 'credits_exhausted',
          needed: 576,
          balance: 40,
          period_end: '2026-11-01T00:00:00Z'
        })
      )
    )
    expect(await screen.findByText(/This needs 576 credits and you have 40/)).toBeVisible()
  })
  it('clears UI on server disable and unsubscribes on unmount', async () => {
    const view = render(<OmniCreditsPill />)
    await screen.findByTestId('omni-credits-pill')
    await act(async () => walletListener(null))
    expect(screen.queryByTestId('omni-credits-pill')).toBeNull()
    view.unmount()
    expect(offWallet).toHaveBeenCalledOnce()
    expect(offError).toHaveBeenCalledOnce()
  })
})
it('handles a main error while the initial read is pending and clears it on unavailable wallet', async () => {
  let resolve!: (value: null) => void
  getWallet.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r
      })
  )
  render(<OmniCreditsPill />)
  await act(async () =>
    exhaustedListener(
      creditsExhaustedSchema.parse({ error: 'credits_exhausted', needed: 576, balance: 40 })
    )
  )
  expect(await screen.findByRole('dialog')).toBeVisible()
  await act(async () => resolve(null))
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('keeps a pushed refusal visible when the first read returns a positive balance', async () => {
  let resolve!: (value: CreditWallet | null) => void
  getWallet.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r
      })
  )
  render(<OmniCreditsPill />)
  await act(async () =>
    exhaustedListener(
      creditsExhaustedSchema.parse({ error: 'credits_exhausted', needed: 576, balance: 40 })
    )
  )
  await act(async () => resolve(wallet({ balance: 40 })))
  expect(await screen.findByRole('dialog')).toBeVisible()
})

it('does not consume a claim whose reply arrives after an unavailable wallet', async () => {
  let resolveRead!: (value: null) => void
  let resolveClaim!: (value: boolean) => void
  const reserved = new Set<string>()
  const displayed = new Set<string>()
  const finishUpgrade = vi.fn(async (id: string, shown: boolean) => {
    reserved.delete(id)
    if (shown) {
      displayed.add(id)
    }
  })
  window.api.omniCredits!.finishUpgrade = finishUpgrade
  claimUpgrade
    .mockImplementationOnce((_period: string, id: string) => {
      reserved.add(id)
      return new Promise<boolean>((resolve) => {
        resolveClaim = resolve
      })
    })
    .mockImplementation(async () => displayed.size === 0 && reserved.size === 0)
  getWallet.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveRead = resolve
      })
  )
  render(<OmniCreditsPill />)
  await act(async () =>
    exhaustedListener(
      creditsExhaustedSchema.parse({ error: 'credits_exhausted', needed: 1, balance: 0 })
    )
  )
  await act(async () => resolveRead(null))
  await act(async () => resolveClaim(true))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(displayed.size).toBe(0)
  await act(async () => walletListener(wallet({ balance: 0 })))
  expect(await screen.findByRole('dialog')).toBeVisible()
  expect(finishUpgrade).toHaveBeenLastCalledWith(expect.any(String), true)
})
it.each([true, false])(
  'reconciles an unknown event period with the wallet (wallet first: %s)',
  async (walletFirst) => {
    let resolveRead!: (value: CreditWallet | null) => void
    if (!walletFirst) {
      getWallet.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRead = resolve
          })
      )
    }
    render(<OmniCreditsPill />)
    if (walletFirst) {
      await screen.findByTestId('omni-credits-pill')
    }
    await act(async () =>
      exhaustedListener(
        creditsExhaustedSchema.parse({ error: 'credits_exhausted', needed: 1, balance: 0 })
      )
    )
    expect(await screen.findByRole('dialog')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    await act(async () => {
      if (!walletFirst) {
        resolveRead(wallet({ balance: 0 }))
      } else {
        walletListener(wallet({ balance: 0 }))
      }
    })
    expect(screen.queryByRole('dialog')).toBeNull()
  }
)
it('preserves the Free plan from wallet to dialog and hides refill copy', async () => {
  getWallet.mockResolvedValue(
    wallet({ balance: 0, plan: { id: 'free', name: 'Free', monthly_credits: 0 } })
  )
  render(<OmniCreditsPill />)
  expect(await screen.findByText('Choose a plan to keep going')).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
  fireEvent.click(screen.getByTestId('omni-credits-pill'))
  expect(screen.queryByText(/refill/i)).toBeNull()
})

it('updates an open pushed prompt when a Free wallet arrives later for the same period', async () => {
  let resolve!: (value: CreditWallet | null) => void
  getWallet.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r
      })
  )
  render(<OmniCreditsPill />)
  await act(async () =>
    exhaustedListener(
      creditsExhaustedSchema.parse({
        error: 'credits_exhausted',
        needed: 1,
        balance: 0,
        period_end: '2026-11-01T00:00:00Z'
      })
    )
  )
  expect(await screen.findByText("You're out of credits")).toBeVisible()
  await act(async () =>
    resolve(wallet({ balance: 0, plan: { id: 'free', name: 'Free', monthly_credits: 0 } }))
  )
  expect(await screen.findByText('Choose a plan to keep going')).toBeVisible()
  expect(screen.queryByText(/refill/i)).toBeNull()
  expect(claimUpgrade).toHaveBeenCalledTimes(1)
})
