/** @vitest-environment happy-dom */
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  beginLaunchIntentDrag,
  clearLaunchIntentDrag,
  LAUNCH_INTENT_DRAG_TYPE
} from '@/lib/launcher-intent-drag'
import { useLaunchContext } from './new-conversation/launch-context'
import { useLaunchIntentDrop } from './use-launch-intent-drop'

const mocks = vi.hoisted(() => ({ info: vi.fn(), paired: new Set<string>() }))
vi.mock('sonner', () => ({ toast: { info: mocks.info, error: vi.fn() } }))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({ runtimeEnvironments: [{ id: 'env-paired', name: 'Studio' }] })
  }
}))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: (_state: unknown, worktreeId: string) =>
    worktreeId === 'paired-workspace' ? 'env-paired' : null
}))
vi.mock('@/runtime/web-runtime-session', () => ({
  isWebRuntimeSessionActive: (environmentId: string | null) =>
    environmentId !== null && mocks.paired.has(environmentId)
}))

beforeEach(() => {
  useLaunchContext.setState({ target: undefined, pendingLaunch: undefined })
  mocks.info.mockClear()
  mocks.paired = new Set(['env-paired'])
})
afterEach(() => {
  cleanup()
  clearLaunchIntentDrag()
})

function dragEvent(start = true) {
  const values = new Map<string, string>()
  const dataTransfer = {
    types: [LAUNCH_INTENT_DRAG_TYPE],
    dropEffect: 'none',
    setData: (type: string, value: string) => {
      values.set(type, value)
    },
    getData: (type: string) => values.get(type) ?? ''
  }
  if (start) {
    beginLaunchIntentDrag(dataTransfer, { agent: 'codex' })
  }
  const event = {
    dataTransfer,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    currentTarget: document.createElement('div'),
    relatedTarget: null
  }
  return Object.assign(event, { asDrag: event as unknown as React.DragEvent<HTMLElement> })
}

it('a session drop targets its workspace and queues one provider pick', () => {
  const { result } = renderHook(() => useLaunchIntentDrop({ worktreeId: 'ssh-workspace' }))
  const drop = dragEvent()
  act(() => result.current.onDragOver(drop.asDrag))
  expect(result.current.over).toBe(true)
  expect(drop.preventDefault).toHaveBeenCalled()
  expect(drop.dataTransfer.dropEffect).toBe('copy')
  act(() => result.current.onDrop(drop.asDrag))
  expect(result.current.over).toBe(false)
  expect(useLaunchContext.getState().target).toEqual({
    kind: 'workspace',
    worktreeId: 'ssh-workspace'
  })
  expect(useLaunchContext.getState().pendingLaunch).toEqual({
    id: expect.any(Number),
    pick: { agent: 'codex' },
    folderId: undefined,
    // The drop carries its own target, the same object the shared target was set to.
    target: useLaunchContext.getState().target
  })
  expect(mocks.info).not.toHaveBeenCalled()
})

it('LP-02: a second drop while one waits is refused with a message and changes nothing', () => {
  const first = renderHook(() => useLaunchIntentDrop({ worktreeId: 'ssh-workspace' }))
  act(() => first.result.current.onDrop(dragEvent().asDrag))
  const pending = useLaunchContext.getState().pendingLaunch
  const second = renderHook(() => useLaunchIntentDrop({ worktreeId: 'paired-workspace' }))
  act(() => second.result.current.onDrop(dragEvent().asDrag))
  expect(useLaunchContext.getState().pendingLaunch).toBe(pending)
  expect(useLaunchContext.getState().target).toEqual({
    kind: 'workspace',
    worktreeId: 'ssh-workspace'
  })
  // Only the refusal: the refused paired-host drop does not also announce a launch.
  expect(mocks.info).toHaveBeenCalledExactlyOnceWith(
    'Launch already starting. Drop again once it has opened.'
  )
})

it('a drop on a paired-host session says where it opens instead of failing silently', () => {
  const { result } = renderHook(() => useLaunchIntentDrop({ worktreeId: 'paired-workspace' }))
  act(() => result.current.onDrop(dragEvent().asDrag))
  expect(useLaunchContext.getState().pendingLaunch?.pick).toEqual({ agent: 'codex' })
  expect(mocks.info).toHaveBeenCalledExactlyOnceWith('Launching on Studio')
})

it('a folder drop queues filing there without changing the launcher target', () => {
  useLaunchContext.getState().setTarget({ kind: 'work-root' })
  const { result } = renderHook(() => useLaunchIntentDrop({ folderId: 'folder-1' }))
  act(() => result.current.onDrop(dragEvent().asDrag))
  expect(useLaunchContext.getState().target).toEqual({ kind: 'work-root' })
  expect(useLaunchContext.getState().pendingLaunch).toEqual(
    expect.objectContaining({
      pick: { agent: 'codex' },
      folderId: 'folder-1',
      target: { kind: 'work-root' }
    })
  )
})

it('non-targets ignore the intent and never highlight', () => {
  const { result } = renderHook(() => useLaunchIntentDrop(undefined))
  const drop = dragEvent()
  act(() => {
    result.current.onDragOver(drop.asDrag)
    result.current.onDrop(drop.asDrag)
  })
  expect(result.current.over).toBe(false)
  expect(drop.preventDefault).not.toHaveBeenCalled()
  expect(useLaunchContext.getState().pendingLaunch).toBeUndefined()
})

it('does not highlight for a launch-intent type that no palette drag started', () => {
  const { result } = renderHook(() => useLaunchIntentDrop({ worktreeId: 'ssh-workspace' }))
  const drop = dragEvent(false)
  act(() => result.current.onDragOver(drop.asDrag))
  expect(result.current.over).toBe(false)
  expect(drop.preventDefault).not.toHaveBeenCalled()
})
