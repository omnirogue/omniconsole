// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  cachedHandoffRead,
  resetHandoffPeopleReads
} from '@/components/next-step/use-handoff-people'
import { useHandoffRosterNames } from './useHandoffRosterNames'

const recipients = vi.hoisted(() => vi.fn())
vi.mock('./handoff-client', () => ({ handoffApi: () => ({ recipients }) }))
const roster = { ok: true as const, data: { employees: [{ id: 'emp_sal', name: 'Sal Baker' }] } }

beforeEach(() => {
  vi.resetAllMocks()
  resetHandoffPeopleReads()
})
afterEach(cleanup)

it('falls back while loading and resolves names without blanking unknown people', async () => {
  let finish!: (value: typeof roster) => void
  recipients.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve
    })
  )
  const { result } = renderHook(() => useHandoffRosterNames('a'))
  expect(result.current('emp_sal')).toBe('emp_sal')
  await waitFor(() => expect(recipients).toHaveBeenCalledOnce())
  await act(async () => finish(roster))
  expect(result.current('emp_sal')).toBe('Sal Baker')
  expect(result.current('emp_sal', true)).toBe('Sal Baker (emp_sal)')
  expect(result.current('emp_unknown')).toBe('emp_unknown')
})

it('reuses the existing roster cache and expires it after sixty seconds', async () => {
  const now = Date.now()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
  recipients.mockResolvedValue(roster)
  try {
    await cachedHandoffRead('roster:a', recipients)
    const first = renderHook(() => useHandoffRosterNames('a'))
    await waitFor(() => expect(first.result.current('emp_sal')).toBe('Sal Baker'))
    expect(recipients).toHaveBeenCalledOnce()
    first.unmount()
    clock.mockReturnValue(now + 60_001)
    renderHook(() => useHandoffRosterNames('a'))
    await waitFor(() => expect(recipients).toHaveBeenCalledTimes(2))
  } finally {
    clock.mockRestore()
  }
})

it('does not expose the old scope while a new scope loads or accepts its late response', async () => {
  let finish!: (value: typeof roster) => void
  recipients.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve
    })
  )
  recipients.mockResolvedValueOnce({
    ok: true,
    data: { employees: [{ id: 'emp_sal', name: 'Other Sal' }] }
  })
  const { result, rerender } = renderHook(({ scope }) => useHandoffRosterNames(scope), {
    initialProps: { scope: 'a' }
  })
  await waitFor(() => expect(recipients).toHaveBeenCalledOnce())
  rerender({ scope: 'b' })
  expect(result.current('emp_sal')).toBe('emp_sal')
  await waitFor(() => expect(result.current('emp_sal')).toBe('Other Sal'))
  await act(async () => finish(roster))
  expect(result.current('emp_sal')).toBe('Other Sal')
})

it.each(['refused', 'rejected', 'blank'])('keeps IDs for a %s roster result', async (kind) => {
  if (kind === 'rejected') {
    recipients.mockRejectedValue(new Error('offline'))
  } else {
    recipients.mockResolvedValue(
      kind === 'refused'
        ? { ok: false, error: { code: 'unavailable', message: 'offline' } }
        : { ok: true, data: { employees: [{ id: 'emp_sal', name: '   ' }] } }
    )
  }
  const { result } = renderHook(() => useHandoffRosterNames('a'))
  await act(async () => {
    await Promise.resolve()
  })
  expect(result.current('emp_sal')).toBe('emp_sal')
})
