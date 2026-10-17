// @vitest-environment happy-dom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { normalizeTaskSourceContext } from '../../../../../shared/task-source-context'
import {
  useBackofficeTaskCompletion,
  useTaskPageBackofficeActions
} from './use-task-page-backoffice'

vi.mock('@/store', () => ({ useAppStore: { getState: vi.fn() } }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('@/lib/floating-terminal', () => ({ requestFloatingTerminalOpen: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('backoffice workspace admission', () => {
  it('carries the selected card identity and revision separately from its title', () => {
    const openModal = vi.fn()
    const taskSourceContext = normalizeTaskSourceContext({
      provider: 'backoffice',
      projectId: 'backoffice',
      hostId: 'local',
      providerIdentity: { provider: 'backoffice', baseUrl: 'https://omnios.example.com' }
    })
    const { result } = renderHook(() =>
      useTaskPageBackofficeActions({
        baseUrl: 'https://omnios.example.com',
        taskSourceContext,
        openModal
      })
    )

    expect(
      result.current.openComposerForBackofficeItem({
        task_id: 'btk_1234',
        title: 'Discuss btk_5678 with the customer',
        href: '/work?task=btk_1234',
        state_revision: 0,
        next_action: 'Draft the reply'
      })
    ).toBe(true)

    expect(openModal).toHaveBeenCalledWith('new-workspace-composer', {
      linkedWorkItem: {
        provider: 'backoffice',
        type: 'issue',
        number: 0,
        title: 'Discuss btk_5678 with the customer',
        url: 'https://omnios.example.com/work?task=btk_1234',
        hubTaskId: 'btk_1234',
        hubStateRevision: 0,
        hubNextAction: 'Draft the reply'
      },
      taskSourceContext,
      prefilledName: 'Discuss btk_5678 with the customer',
      telemetrySource: 'sidebar'
    })
  })
})

describe('backoffice task completion', () => {
  it('uses the observed revision, surfaces stale errors, and refreshes server state', async () => {
    const completeTask = vi.fn().mockResolvedValue({
      ok: false,
      message: 'The task revision changed.',
      stale: true
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { backoffice: { completeTask } }
    })
    const refresh = vi.fn()
    const item = { task_id: 'btk_1234', title: 'Ship completion', state_revision: 6 }
    const { result } = renderHook(() => useBackofficeTaskCompletion(refresh))

    act(() => result.current.complete(item))

    await waitFor(() =>
      expect(completeTask).toHaveBeenCalledWith({ taskId: 'btk_1234', expectedRevision: 6 })
    )
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce())
    expect(toast.error).toHaveBeenCalledWith('The task revision changed.')
  })

  it('asks for evidence when the done-gate wants it, then retries with the result ref', async () => {
    const completeTask = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        message: 'cannot be done without evidence',
        needsEvidence: true
      })
      .mockResolvedValueOnce({ ok: true })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { backoffice: { completeTask } }
    })
    const refresh = vi.fn()
    const item = { task_id: 'btk_1234', title: 'Check ide', state_revision: 6 }
    const { result } = renderHook(() => useBackofficeTaskCompletion(refresh))

    act(() => result.current.complete(item))
    await waitFor(() => expect(result.current.evidenceRequest).toEqual(item))
    expect(toast.error).not.toHaveBeenCalled()

    act(() => result.current.complete(item, 'https://example.com/pr/1'))
    await waitFor(() =>
      expect(completeTask).toHaveBeenLastCalledWith({
        taskId: 'btk_1234',
        expectedRevision: 6,
        resultRef: 'https://example.com/pr/1'
      })
    )
    await waitFor(() => expect(result.current.evidenceRequest).toBeNull())
    expect(refresh).toHaveBeenCalledOnce()
  })
})
