// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWorkCardTitles } from './use-work-card-titles'

const mocks = vi.hoisted(() => ({ scope: 'account-a' }))
vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (state: object) => unknown) => selector({}), {
    getState: () => ({})
  })
}))
vi.mock('@/lib/console-account-scope', () => ({
  selectConsoleAccountScope: () => mocks.scope
}))

const listWork = vi.fn()

function board(
  items: { id: string; title: string }[],
  extra: { total?: number; capped?: boolean } = {}
) {
  return {
    ok: true,
    data: { items, total: extra.total ?? items.length, capped: extra.capped ?? false }
  }
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  mocks.scope = 'account-a'
  listWork.mockReset()
  listWork.mockResolvedValue(board([{ id: 'btk_same1', title: 'A secret' }]))
  Object.assign(window, { api: { consoleWorkflows: { listWork } } })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  Object.assign(window, { api: {} })
})

const IDS = ['btk_same1']

describe('useWorkCardTitles', () => {
  it('resolves a title the device knows only by card id', async () => {
    const { result } = renderHook(() => useWorkCardTitles(IDS))
    await waitFor(() => expect(result.current.titles.get('btk_same1')).toBe('A secret'))
    expect(result.current.status).toBe('ready')
  })

  it('never shows one account’s card title under another account', async () => {
    const { result, rerender } = renderHook(() => useWorkCardTitles(IDS))
    await waitFor(() => expect(result.current.titles.get('btk_same1')).toBe('A secret'))

    // Why: the same local pane can carry a card id that names different work per account;
    // keeping the first answer leaks one account's task name into another.
    listWork.mockResolvedValue(board([{ id: 'btk_same1', title: 'B title' }]))
    mocks.scope = 'account-b'
    rerender()
    await waitFor(() => expect(result.current.titles.get('btk_same1')).toBe('B title'))
    expect(listWork).toHaveBeenCalledTimes(2)
  })

  it('asks again for an id a capped board never looked at', async () => {
    // Why: a shortened board omits cards it did not read, so a missing id is unread, not absent.
    listWork.mockResolvedValueOnce(board([], { total: 2_000, capped: true }))
    const { result } = renderHook(() => useWorkCardTitles(IDS))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect([...result.current.unresolved]).toEqual(['btk_same1'])

    listWork.mockResolvedValueOnce(board([{ id: 'btk_same1', title: 'Found later' }]))
    act(() => result.current.retry())
    await waitFor(() => expect(result.current.titles.get('btk_same1')).toBe('Found later'))
    expect(listWork).toHaveBeenCalledTimes(2)
  })

  it('does not ask again for an id a complete board answered for', async () => {
    listWork.mockResolvedValueOnce(board([{ id: 'btk_other', title: 'Something else' }]))
    const { result } = renderHook(() => useWorkCardTitles(IDS))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    // The console answered and does not carry this card: that is a real absence.
    expect([...result.current.unresolved]).toEqual(['btk_same1'])

    act(() => result.current.retry())
    await act(async () => {})
    expect(listWork).toHaveBeenCalledTimes(1)
  })

  it('reports a refused read and repairs it instead of marking the id answered', async () => {
    vi.useFakeTimers()
    try {
      listWork
        .mockRejectedValueOnce(new Error('console unreachable'))
        .mockResolvedValueOnce(board([{ id: 'btk_same1', title: 'Back online' }]))
      const { result } = renderHook(() => useWorkCardTitles(IDS))
      await act(async () => {})
      expect(result.current.status).toBe('error')
      expect([...result.current.unresolved]).toEqual(['btk_same1'])

      await act(async () => {
        vi.advanceTimersByTime(5_000)
      })
      expect(listWork).toHaveBeenCalledTimes(2)
      expect(result.current.titles.get('btk_same1')).toBe('Back online')
    } finally {
      vi.useRealTimers()
    }
  })
})
