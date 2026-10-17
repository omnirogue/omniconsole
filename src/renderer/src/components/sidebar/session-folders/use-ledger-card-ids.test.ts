// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LedgerLocalSession } from '../../../../../shared/session-ledger-contract'
import { ledgerCardIdsByPane, useLedgerCardIds } from './use-ledger-card-ids'

const mocks = vi.hoisted(() => ({ scope: 'account-a' }))
vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (state: object) => unknown) => selector({}), {
    getState: () => ({})
  })
}))
vi.mock('@/lib/console-account-scope', () => ({
  selectConsoleAccountScope: () => mocks.scope
}))

function localSession(paneId: string, cardId: string | null): LedgerLocalSession {
  return { paneId, cardId } as LedgerLocalSession
}

const ledger = {
  localSessions: vi.fn(),
  onLocalSessionsChanged: vi.fn(() => () => {})
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  mocks.scope = 'account-a'
  ledger.localSessions.mockReset()
  ledger.onLocalSessionsChanged.mockClear()
  ledger.localSessions.mockResolvedValue([localSession('tab-1:leaf', 'btk_one')])
  Object.assign(window, { api: { sessionLedger: ledger } })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  Object.assign(window, { api: {} })
})

describe('ledgerCardIdsByPane', () => {
  it('keeps only panes carrying a hub card', () => {
    const cards = ledgerCardIdsByPane([
      localSession('tab-1:leaf', 'btk_one'),
      localSession('tab-2:leaf', null),
      localSession('tab-3:leaf', 'not-a-card')
    ])
    expect([...cards]).toEqual([['tab-1:leaf', 'btk_one']])
  })
})

describe('useLedgerCardIds', () => {
  it('reports nothing instead of the previous cards when a later read fails', async () => {
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useLedgerCardIds(enabled),
      { initialProps: { enabled: true } }
    )
    await waitFor(() => expect(result.current.cards.get('tab-1:leaf')).toBe('btk_one'))

    rerender({ enabled: false })
    // Why: a failed read means "unknown"; answering with the old map files sessions under a
    // task the ledger may no longer say they serve.
    ledger.localSessions.mockRejectedValueOnce(new Error('ledger unavailable'))
    rerender({ enabled: true })
    await waitFor(() => expect(result.current.cards.size).toBe(0))
  })

  it('tells a refused read apart from a ledger that is genuinely empty', async () => {
    ledger.localSessions.mockResolvedValueOnce([])
    const empty = renderHook(() => useLedgerCardIds(true))
    await waitFor(() => expect(empty.result.current.status).toBe('ready'))
    // Why: an empty ledger is an answer — these panes serve no task.
    expect(empty.result.current.unknown).toBe(false)
    cleanup()

    ledger.localSessions.mockRejectedValue(new Error('ledger unavailable'))
    const refused = renderHook(() => useLedgerCardIds(true))
    await waitFor(() => expect(refused.result.current.status).toBe('error'))
    // Why: a refusal is not evidence of absence, and the old code made the two identical.
    expect(refused.result.current.unknown).toBe(true)
    expect(refused.result.current.cards.size).toBe(0)
    expect(console.warn).toHaveBeenCalled()
  })

  it('says so instead of reporting an empty ledger when the build carries no ledger API', async () => {
    Object.assign(window, { api: {} })
    const { result } = renderHook(() => useLedgerCardIds(true))
    await waitFor(() => expect(result.current.status).toBe('unsupported'))
    expect(result.current.unknown).toBe(true)
  })

  it('repairs a refused read by itself, without waiting for the lens to be toggled', async () => {
    vi.useFakeTimers()
    try {
      ledger.localSessions
        .mockRejectedValueOnce(new Error('ledger unavailable'))
        .mockResolvedValueOnce([localSession('tab-a:leaf', 'btk_new1')])
      const { result } = renderHook(() => useLedgerCardIds(true))
      await act(async () => {})
      expect(result.current.status).toBe('error')
      expect(ledger.localSessions).toHaveBeenCalledTimes(1)

      await act(async () => {
        vi.advanceTimersByTime(5_000)
      })
      expect(ledger.localSessions).toHaveBeenCalledTimes(2)
      expect(result.current.cards.get('tab-a:leaf')).toBe('btk_new1')
      expect(result.current.status).toBe('ready')
    } finally {
      vi.useRealTimers()
    }
  })

  it('re-reads the ledger when the account changes', async () => {
    const { result, rerender } = renderHook(() => useLedgerCardIds(true))
    await waitFor(() => expect(result.current.cards.get('tab-1:leaf')).toBe('btk_one'))
    expect(ledger.localSessions).toHaveBeenCalledTimes(1)

    // Why: the ledger belongs to the signed-in profile; its cards do not survive a switch.
    ledger.localSessions.mockResolvedValue([localSession('tab-9:leaf', 'btk_other')])
    mocks.scope = 'account-b'
    rerender()
    await waitFor(() => expect(result.current.cards.get('tab-9:leaf')).toBe('btk_other'))
    expect(result.current.cards.has('tab-1:leaf')).toBe(false)
  })
})
