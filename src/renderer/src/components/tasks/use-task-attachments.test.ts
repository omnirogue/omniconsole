// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useTaskAttachments } from './use-task-attachments'
import type { ExactHandoffFile } from '../../../../shared/console-handoff-contract'

const fixture = vi.hoisted(() => ({ scope: 'person-a', uploadFile: vi.fn() }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({ scope: fixture.scope }) } }))
vi.mock('@/lib/console-account-scope', () => ({
  selectConsoleAccountScope: (state: { scope: string }) => state.scope
}))
vi.mock('@/components/handoffs/handoff-client', () => ({ handoffApi: () => fixture }))
const file = (name: string): ExactHandoffFile => ({
  name,
  contentBase64: 'dGVzdA==',
  size: 4,
  sha256: 'a'.repeat(64)
})
afterEach(cleanup)
beforeEach(() => {
  fixture.scope = 'person-a'
  fixture.uploadFile.mockReset()
})

it('retries only failed files against the same saved task and original principal', async () => {
  fixture.uploadFile
    .mockResolvedValueOnce({ ok: true, data: { path: 'first.txt' } })
    .mockResolvedValueOnce({ ok: false, error: { code: 'offline', message: 'Offline' } })
    .mockResolvedValueOnce({ ok: true, data: { path: 'second.txt' } })
  const { result } = renderHook(() => useTaskAttachments())
  act(() => result.current.add(file('first.txt')))
  act(() => result.current.add(file('second.txt')))
  await act(async () => {
    expect(await result.current.upload('btk_outcome1', 'b'.repeat(64))).toBe(false)
  })
  expect(result.current.entries.map((entry) => entry.saved)).toEqual([true, false])
  await act(async () => {
    expect(await result.current.upload('btk_outcome1', 'b'.repeat(64))).toBe(true)
  })
  expect(
    fixture.uploadFile.mock.calls.map(([input]) => [
      input.taskId,
      input.file.name,
      input.expectedPrincipal
    ])
  ).toEqual([
    ['btk_outcome1', 'first.txt', 'b'.repeat(64)],
    ['btk_outcome1', 'second.txt', 'b'.repeat(64)],
    ['btk_outcome1', 'second.txt', 'b'.repeat(64)]
  ])
})

it('does not publish held file bytes after an account switch or without a main-issued principal', async () => {
  const { result } = renderHook(() => useTaskAttachments())
  act(() => result.current.add(file('brief.txt')))
  await act(async () => {
    expect(await result.current.upload('btk_outcome1')).toBe(false)
  })
  fixture.scope = 'person-b'
  await act(async () => {
    expect(await result.current.upload('btk_outcome1', 'b'.repeat(64))).toBe(false)
  })
  expect(fixture.uploadFile).not.toHaveBeenCalled()
})

it('stops the batch when the signed-in account changes during upload', async () => {
  fixture.uploadFile.mockImplementation(async () => {
    fixture.scope = 'person-b'
    return { ok: true, data: { path: 'first.txt' } }
  })
  const { result } = renderHook(() => useTaskAttachments())
  act(() => result.current.add(file('first.txt')))
  act(() => result.current.add(file('second.txt')))
  await act(async () => {
    expect(await result.current.upload('btk_outcome1', 'b'.repeat(64))).toBe(false)
  })
  expect(fixture.uploadFile).toHaveBeenCalledTimes(1)
  expect(result.current.entries.every((entry) => !entry.saved)).toBe(true)
})
