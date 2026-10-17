// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { OpenInPaneContext, useOpenInPane, useOpenInPaneHandler } from './open-in-pane-context'

const state = vi.hoisted(() => ({ settings: { commandCenter: false } }))
vi.mock('@/store', () => ({
  useAppStore: (select: (value: typeof state) => unknown) => select(state)
}))
afterEach(cleanup)

it.each([false, true])('uses the existing opener without a provider (enabled=%s)', (enabled) => {
  state.settings.commandCenter = enabled
  const fallback = vi.fn()
  const { result } = renderHook(() => useOpenInPane(fallback))
  result.current('https://omnios.example/work/decisions')
  expect(fallback).toHaveBeenCalledWith('https://omnios.example/work/decisions')
})

it('uses the provider only with commandCenter enabled', () => {
  const provider = vi.fn()
  const fallback = vi.fn()
  const wrapper = ({ children }: { children: ReactNode }) => (
    <OpenInPaneContext.Provider value={provider}>{children}</OpenInPaneContext.Provider>
  )
  state.settings.commandCenter = false
  const { result, rerender } = renderHook(
    () => ({ open: useOpenInPane(fallback), provider: useOpenInPaneHandler() }),
    { wrapper }
  )
  expect(result.current.provider).toBeNull()
  result.current.open('https://omnios.example/a/review')
  expect(fallback).toHaveBeenCalledOnce()
  expect(provider).not.toHaveBeenCalled()
  state.settings.commandCenter = true
  rerender()
  result.current.open('https://omnios.example/a/review')
  expect(provider).toHaveBeenCalledWith('https://omnios.example/a/review')
})
