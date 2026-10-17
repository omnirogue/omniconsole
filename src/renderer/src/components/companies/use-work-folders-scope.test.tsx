// @vitest-environment happy-dom

import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useHandoffScope } from '../handoffs/handoff-scope'
import {
  resetWorkFoldersCacheForTest,
  useWorkFolders,
  useWorkFoldersScope,
  workFoldersScope
} from './use-work-folders'

const state = vi.hoisted(() => ({
  value: {
    activeOrcaProfileId: 'profile-1',
    orcaProfileAuthStatus: {
      state: 'signed-in',
      cloud: { userId: 'person-1', cloudProfileId: 'cloud-1', activeOrgId: 'org-1' }
    },
    settings: { backofficeEnv: 'production' }
  },
  folders: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (select: (value: typeof state.value) => unknown) => select(state.value),
    {
      getState: () => state.value
    }
  )
}))
vi.mock('./companies-client', () => ({
  companiesApi: () => ({ folders: state.folders }),
  companiesData: (result: { data: unknown }) => result.data
}))

function Filing() {
  const folders = useWorkFolders(useWorkFoldersScope())
  return <div data-testid="filing">{folders.data?.companies[0]?.name ?? 'loading'}</div>
}

function Recipients() {
  const folders = useWorkFolders(useHandoffScope())
  return <div data-testid="recipients">{folders.data?.companies[0]?.name ?? 'loading'}</div>
}

function Dialog() {
  return (
    <>
      <Filing />
      <Recipients />
    </>
  )
}

function response(name: string) {
  return { ok: true, data: { companies: [{ id: name, name }] } }
}

describe('task filing and handoff folder ownership', () => {
  afterEach(() => {
    cleanup()
    resetWorkFoldersCacheForTest()
    state.folders.mockReset()
    state.value.orcaProfileAuthStatus.cloud.userId = 'person-1'
  })

  it('keeps companies available when filing and recipient consumers mount together', async () => {
    state.folders.mockResolvedValue(response('Company A'))
    const { getByTestId } = render(<Dialog />)
    await waitFor(() => {
      expect(getByTestId('filing').textContent).toBe('Company A')
      expect(getByTestId('recipients').textContent).toBe('Company A')
    })
    expect(state.folders).toHaveBeenCalledOnce()
  })

  it('discards a late folder response after the signed-in person changes', async () => {
    let resolveOld!: (value: ReturnType<typeof response>) => void
    const old = new Promise<ReturnType<typeof response>>((resolve) => {
      resolveOld = resolve
    })
    state.folders.mockReturnValueOnce(old).mockResolvedValueOnce(response('Company B'))
    const before = workFoldersScope()
    const { getByTestId, rerender } = render(<Dialog />)
    await waitFor(() => expect(state.folders).toHaveBeenCalledOnce())
    state.value.orcaProfileAuthStatus.cloud.userId = 'person-2'
    expect(workFoldersScope()).not.toBe(before)
    rerender(<Dialog />)
    await waitFor(() => expect(getByTestId('filing').textContent).toBe('Company B'))

    await act(async () => {
      resolveOld(response('Company A'))
      await old
    })
    expect(getByTestId('filing').textContent).toBe('Company B')
    expect(getByTestId('recipients').textContent).toBe('Company B')
    expect(state.folders).toHaveBeenCalledTimes(2)
  })
})
