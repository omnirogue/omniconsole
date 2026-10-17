// @vitest-environment happy-dom
/**
 * The other end of U-49: the surface finishes what the host handed back.
 *
 * `upNext.commit` answers a Done on a conversation with no pursuit with the CHOICE, and the
 * mount calls its own ✓ Done door with it — once. A surface with no finish door refuses in the
 * composer's own words rather than swallowing the block.
 */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { useUpNext } from './use-up-next'
import { upNextFixture } from './up-next-fixture'
import en from '@/i18n/locales/en.json'
import type { UpNextView } from '../../../../shared/up-next-types'
import type { SessionFinishChoice } from '../../../../shared/session-finish-intent'

vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: vi.fn() }))
afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})

/** The host: every read answers with the view, and the commit also answers with the finish. */
function host(finish?: SessionFinishChoice): UpNextView {
  const view = upNextFixture()
  vi.mocked(callRuntimeRpc).mockImplementation(async (_, method) =>
    method === 'upNext.commit' ? { view, ...(finish ? { finish } : {}) } : { view }
  )
  return view
}

it('calls the surface finish door once, with the choice the host answered', async () => {
  const view = host({ action: 'save', folderId: 'saved-sessions' })
  const finish = vi.fn(async () => {})
  const { result } = renderHook(() =>
    useUpNext(view.conversationId as never, undefined, { finish })
  )
  await waitFor(() => expect(result.current.view).toEqual(view))

  await act(async () => {
    expect(await result.current.commit()).toBe(true)
  })

  expect(finish).toHaveBeenCalledTimes(1)
  expect(finish).toHaveBeenCalledWith(
    { action: 'save', folderId: 'saved-sessions' },
    view.conversationId
  )
})

it('leaves an ordinary commit alone', async () => {
  const view = host()
  const finish = vi.fn(async () => {})
  const { result } = renderHook(() =>
    useUpNext(view.conversationId as never, undefined, { finish })
  )
  await waitFor(() => expect(result.current.view).toEqual(view))

  await act(async () => {
    expect(await result.current.commit()).toBe(true)
  })

  expect(finish).not.toHaveBeenCalled()
})

it('refuses in words when the surface owns no finish door', async () => {
  const view = host({ action: 'end' })
  const errors: string[] = []
  const { result } = renderHook(() =>
    useUpNext(view.conversationId as never, (message) => errors.push(message), {})
  )
  await waitFor(() => expect(result.current.view).toEqual(view))

  await act(async () => {
    expect(await result.current.commit()).toBe(false)
  })

  expect(errors).toEqual([en.upNext.refusal.doneNeedsWork])
})
