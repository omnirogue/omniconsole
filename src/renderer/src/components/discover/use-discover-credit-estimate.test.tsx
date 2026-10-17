// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createLocalWorkflowGraphDraft } from '../../../../shared/local-workflow-draft'
import type { DiscoverCreditQuoteResult } from '../../../../shared/discover-credit-quote-ipc'
import { normalizeWorkflowSpec } from '../../../../shared/workflow-graph-normalize'
import { quickDiscoverWorkflow } from '../../../../shared/workflow-graph-quick-discover'
import { useDiscoverCreditEstimate } from './use-discover-credit-estimate'

const { creditBilling } = vi.hoisted(() => ({ creditBilling: vi.fn(() => true) }))
vi.mock('@/store', () => ({ useAppStore: creditBilling }))

const spec = normalizeWorkflowSpec(quickDiscoverWorkflow(['claude', 'codex']))
const draft = createLocalWorkflowGraphDraft({ prompt: 'Find defects', graph: { spec, team: [] } })
const pricing = { creditsPerAgent: 2, maxCreditsPerAgent: 5 }
const approved: DiscoverCreditQuoteResult = {
  quote: {
    mode: 'quick',
    estimatedCredits: 2,
    maxReservationCredits: 5,
    quickMaxReservationCredits: 10,
    agentCalls: { low: 1, high: 1 },
    balance: { availableCredits: 50, updatedAt: '2026-10-16T00:00:00Z' },
    balanceStatus: 'available'
  },
  guard: { allowed: true, shortfallCredits: 0, warningMessage: null, recommendedAction: 'proceed' }
}
const quote = vi.fn<() => Promise<DiscoverCreditQuoteResult>>()
const unsubscribeAccount = vi.fn()
const unsubscribeBalance = vi.fn()
let accountChanged: () => void

beforeEach(() => {
  vi.useFakeTimers()
  creditBilling.mockReturnValue(true)
  vi.stubGlobal('api', {
    localWorkflow: { quoteDiscoverCredits: quote },
    omnirogue: {
      account: {
        onStatusChanged: (callback: () => void) => {
          accountChanged = callback
          return unsubscribeAccount
        }
      },
      credits: { onBalanceChanged: () => unsubscribeBalance }
    }
  })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.resetAllMocks()
})
const settle = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(250)
  })

it('blocks until a quote arrives and invalidates approval as soon as the draft changes', async () => {
  quote.mockResolvedValue(approved)
  const { result, rerender } = renderHook(
    ({ prompt }) => useDiscoverCreditEstimate('w', { ...draft, prompt }, spec, pricing),
    { initialProps: { prompt: 'Find defects' } }
  )
  expect(result.current.allowed).toBe(false)
  await settle()
  expect(result.current.allowed).toBe(true)
  rerender({ prompt: 'Find security defects' })
  expect(result.current.allowed).toBe(false)
  expect(result.current.quote).toBeNull()
  await settle()
  expect(result.current.allowed).toBe(true)
})

it('ignores an older approval that arrives after the newer request is refused', async () => {
  let resolveOld!: (value: DiscoverCreditQuoteResult) => void
  quote.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOld = resolve
      })
  )
  quote.mockResolvedValueOnce({ quote: null, guard: null })
  const { result, rerender } = renderHook(
    ({ rate }) =>
      useDiscoverCreditEstimate('w', draft, spec, { ...pricing, creditsPerAgent: rate }),
    { initialProps: { rate: 2 } }
  )
  await settle()
  rerender({ rate: 3 })
  await settle()
  await act(async () => {
    resolveOld(approved)
  })
  expect(result.current.allowed).toBe(false)
  expect(result.current.quote).toBeNull()
})

it('refreshes on account changes and removes subscriptions on unmount', async () => {
  quote.mockResolvedValue(approved)
  const { result, unmount } = renderHook(() => useDiscoverCreditEstimate('w', draft, spec, pricing))
  await settle()
  act(() => accountChanged())
  expect(result.current.allowed).toBe(false)
  quote.mockRejectedValueOnce(new Error('Disconnected'))
  await settle()
  expect(result.current.allowed).toBe(false)
  unmount()
  expect(unsubscribeAccount).toHaveBeenCalledOnce()
  expect(unsubscribeBalance).toHaveBeenCalledOnce()
})

it('does not quote or block unrelated workflows', async () => {
  const { result } = renderHook(() =>
    useDiscoverCreditEstimate('w', draft, { ...spec, template: 'custom' })
  )
  await settle()
  expect(result.current.enabled).toBe(false)
  expect(result.current.allowed).toBe(true)
  expect(quote).not.toHaveBeenCalled()
})

it("does not require wallet credits for runs using the person's own login", async () => {
  creditBilling.mockReturnValue(false)
  const { result } = renderHook(() => useDiscoverCreditEstimate('w', draft, spec))
  await settle()
  expect(result.current.enabled).toBe(false)
  expect(result.current.allowed).toBe(true)
  expect(quote).not.toHaveBeenCalled()
})

it('lets the wallet guard alone decide when no pricing provider supplies rates', async () => {
  quote.mockResolvedValue({
    quote: null,
    guard: {
      allowed: true,
      shortfallCredits: 0,
      warningMessage: 'no estimate',
      recommendedAction: 'proceed'
    }
  })
  const { result } = renderHook(() => useDiscoverCreditEstimate('w', draft, spec))
  expect(result.current.allowed).toBe(false)
  await settle()
  expect(result.current.allowed).toBe(true)
  quote.mockResolvedValue({ quote: null, guard: { ...approved.guard!, allowed: false } })
  act(() => accountChanged())
  await settle()
  expect(result.current.allowed).toBe(false)
})
