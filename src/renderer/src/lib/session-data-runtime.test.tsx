// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import {
  ensureSessionDataRuntime,
  localSessionDataRuntimeKey,
  useSessionDataRuntimeKey
} from './session-data-runtime'
import type { RuntimeStatus } from '../../../shared/runtime-types'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
function runtime(getStatus: () => Promise<RuntimeStatus>): void {
  vi.stubGlobal('api', { runtime: { getStatus } })
}
const status = (runtimeId: string) => ({ runtimeId }) as RuntimeStatus

it('coalesces runtime identity reads and switches every reader to the observed runtime on focus', async () => {
  const getStatus = vi.fn().mockResolvedValue(status('first'))
  runtime(getStatus)
  const first = renderHook(useSessionDataRuntimeKey)
  const second = renderHook(useSessionDataRuntimeKey)
  await act(async () => {
    await ensureSessionDataRuntime()
  })
  expect(getStatus).toHaveBeenCalledTimes(1)
  expect(first.result.current).toBe('local:first')
  expect(second.result.current).toBe('local:first')
  getStatus.mockResolvedValue(status('replacement'))
  await act(async () => {
    window.dispatchEvent(new Event('focus'))
    await Promise.resolve()
  })
  expect(getStatus).toHaveBeenCalledTimes(2)
  expect(first.result.current).toBe('local:replacement')
  expect(second.result.current).toBe('local:replacement')
  first.unmount()
  second.unmount()
  getStatus.mockResolvedValue(status('after-hidden'))
  const restored = renderHook(useSessionDataRuntimeKey)
  await act(async () => {
    await ensureSessionDataRuntime()
  })
  expect(restored.result.current).toBe('local:after-hidden')
  expect(getStatus).toHaveBeenCalledTimes(3)
})

it('isolates an unobserved bridge, retries after an outage and drops predecessor identity replies', async () => {
  const failed = vi.fn().mockRejectedValue(new Error('offline'))
  runtime(failed)
  const key = localSessionDataRuntimeKey()
  await ensureSessionDataRuntime()
  expect(localSessionDataRuntimeKey()).toBe(key)
  failed.mockResolvedValue(status('recovered'))
  await ensureSessionDataRuntime()
  expect(localSessionDataRuntimeKey()).toBe('local:recovered')
  let finish!: (value: RuntimeStatus) => void
  runtime(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const pending = ensureSessionDataRuntime()
  await Promise.resolve()
  runtime(async () => status('new-bridge'))
  await ensureSessionDataRuntime()
  finish(status('late-old-bridge'))
  await pending
  expect(localSessionDataRuntimeKey()).toBe('local:new-bridge')
})

it('keeps snapshot identity stable when the runtime namespace is accessed through a proxy', async () => {
  const getStatus = vi.fn().mockResolvedValue(status('proxied'))
  vi.stubGlobal('api', {
    get runtime() {
      return { getStatus }
    }
  })
  const first = renderHook(useSessionDataRuntimeKey)
  const second = renderHook(useSessionDataRuntimeKey)
  expect(first.result.current).toBe(second.result.current)
  await act(async () => {
    await ensureSessionDataRuntime()
  })
  expect(first.result.current).toBe('local:proxied')
  expect(second.result.current).toBe('local:proxied')
  expect(getStatus).toHaveBeenCalledTimes(1)
})
