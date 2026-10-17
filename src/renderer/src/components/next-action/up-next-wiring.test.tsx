// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { useUpNext } from './use-up-next'
import { upNextFixture } from './up-next-fixture'
import {
  UP_NEXT_REFUSAL_KEYS,
  UP_NEXT_WRITE_UNAVAILABLE,
  type UpNextPersonBlock
} from '../../../../shared/up-next-types'
import en from '@/i18n/locales/en.json'
import { runPromptQueueCommand } from '../prompt-queue/prompt-queue-command-runner'
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: vi.fn() }))
afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})

it.each([
  { kind: 'thread', threadId: 'thread' } as const,
  { kind: 'card', taskId: 'task' } as const
])('composes on $kind and adopts after the surface starts', async (subject) => {
  const view = { ...upNextFixture(), conversationId: subject }
  const source = { kind: 'pty', worktreeId: 'w', paneKey: 'p' } as const
  const order: string[] = []
  vi.mocked(callRuntimeRpc).mockImplementation(async (_, method, params) => {
    order.push(method)
    return {
      view: {
        ...view,
        conversationId: (params as { conversationId: typeof subject }).conversationId
      }
    }
  })
  const start = vi.fn(async () => {
    order.push('start')
    return source
  })
  const { result } = renderHook(() => useUpNext(subject, undefined, { start }))
  await waitFor(() => expect(result.current.view).toEqual(view))
  await act(async () => {
    await result.current.append({ kind: 'prompt', text: 'hello' })
    await result.current.update('draft:1', { kind: 'prompt', text: 'edited' })
    await result.current.commit()
  })
  expect(order.indexOf('start')).toBeLessThan(order.indexOf('upNext.commit'))
  expect(callRuntimeRpc).toHaveBeenCalledWith({ kind: 'local' }, 'upNext.commit', {
    conversationId: source,
    adoptFrom: subject
  })
  expect(result.current.view?.conversationId).toEqual(source)
})

it.each([true, false])(
  'creates an opted-in Person card before commit: %s',
  async (createTaskCard) => {
    const person: UpNextPersonBlock = {
      id: 'person',
      kind: 'person',
      number: '1',
      state: 'draft',
      locked: false,
      relationship: 'handoff',
      people: [{ id: 'sal', name: 'Sal', initials: 'S' }],
      receive: { files: true, transcript: false, createTaskCard }
    }
    const view = { ...upNextFixture(), blocks: [person] }
    const order: string[] = []
    vi.mocked(callRuntimeRpc).mockImplementation(async (_, method, params) => {
      order.push(method)
      if (method === 'upNext.update') {
        Object.assign(person, (params as { patch: object }).patch)
      }
      if (method === 'upNext.commit' && createTaskCard) {
        expect(person.receive.attachTaskId).toBe('created')
      }
      return { view }
    })
    const createCard = vi.fn(async () => {
      order.push('createCard')
      return 'created'
    })
    const { result } = renderHook(() => useUpNext(view.conversationId, undefined, { createCard }))
    await waitFor(() => expect(result.current.view).toEqual(view))
    await act(async () => {
      expect(await result.current.commit()).toBe(true)
    })
    expect(createCard).toHaveBeenCalledTimes(createTaskCard ? 1 : 0)
    if (createTaskCard) {
      expect(order.indexOf('createCard')).toBeLessThan(order.indexOf('upNext.update'))
      expect(order.indexOf('upNext.update')).toBeLessThan(order.indexOf('upNext.commit'))
      expect(callRuntimeRpc).toHaveBeenCalledWith(
        { kind: 'local' },
        'upNext.update',
        expect.objectContaining({
          patch: { kind: 'person', people: [{ id: 'sal', name: 'Sal' }], receive: person.receive }
        })
      )
    }
  }
)

it.each(Object.values(UP_NEXT_REFUSAL_KEYS))('shows the localized refusal %s', async (message) => {
  const view = upNextFixture()
  vi.mocked(callRuntimeRpc).mockImplementation(async (_, method) => {
    if (method === 'upNext.list') {
      return { view }
    }
    throw new Error(message)
  })
  let append: ReturnType<typeof useUpNext>['append']
  function ErrorSurface() {
    const controller = useUpNext(view.conversationId)
    append = controller.append
    return <p role="alert">{controller.error}</p>
  }
  render(<ErrorSurface />)
  await act(async () => {
    await append({ kind: 'done' })
  })
  const key = message.split('.').at(-1) as keyof typeof en.upNext.refusal
  expect(screen.getByRole('alert').textContent).toBe(
    en.upNext.refusal[key] ?? UP_NEXT_WRITE_UNAVAILABLE
  )
})

it.each(['unknown failure', 'This outcome has an in-flight action. Reconcile it before editing.'])(
  // A host sentence that states no catalog rule is shown as-is, not collapsed into the
  // generic banner (measured live: evidence/na-live-phase1-20260918T043728Z/cli/20g).
  'shows a host sentence that states no catalog rule verbatim: %s',
  async (message) => {
    const view = upNextFixture()
    vi.mocked(callRuntimeRpc).mockImplementation(async (_, method) => {
      if (method === 'upNext.list') {
        return { view }
      }
      throw new Error(message)
    })
    let append: ReturnType<typeof useUpNext>['append']
    function ErrorSurface() {
      const controller = useUpNext(view.conversationId)
      append = controller.append
      return <p role="alert">{controller.error}</p>
    }
    render(<ErrorSurface />)
    await act(async () => {
      await append({ kind: 'done' })
    })
    expect(screen.getByRole('alert').textContent).toBe(message)
  }
)

it('falls back to the generic sentence for a raw catalog key this renderer cannot map', async () => {
  const view = upNextFixture()
  vi.mocked(callRuntimeRpc).mockImplementation(async (_, method) => {
    if (method === 'upNext.list') {
      return { view }
    }
    throw new Error('upNext.refusal.someFutureRuleThisRendererDoesNotKnowYet')
  })
  let append: ReturnType<typeof useUpNext>['append']
  function ErrorSurface() {
    const controller = useUpNext(view.conversationId)
    append = controller.append
    return <p role="alert">{controller.error}</p>
  }
  render(<ErrorSurface />)
  await act(async () => {
    await append({ kind: 'done' })
  })
  expect(screen.getByRole('alert').textContent).toBe(UP_NEXT_WRITE_UNAVAILABLE)
})

it('sends /next to the head', async () => {
  const source = { kind: 'pty', worktreeId: 'w', paneKey: 'p' } as const
  vi.mocked(callRuntimeRpc).mockResolvedValue({
    view: { ...upNextFixture(), conversationId: source }
  })
  await runPromptQueueCommand(source, { kind: 'add', text: 'next' })
  expect(callRuntimeRpc).toHaveBeenCalledWith(
    { kind: 'local' },
    'upNext.append',
    expect.objectContaining({ conversationId: source, position: 'head' })
  )
})

it('refuses /next when the host reads back a different conversation', async () => {
  const source = { kind: 'pty', worktreeId: 'w', paneKey: 'p' } as const
  vi.mocked(callRuntimeRpc).mockResolvedValue({
    view: { ...upNextFixture(), conversationId: { ...source, worktreeId: 'other' } }
  })
  const result = await runPromptQueueCommand(source, { kind: 'add', text: 'Stay here' })
  expect(result.queued).toBe(false)
  expect(result.notice).toContain('different conversation')
  expect(callRuntimeRpc).toHaveBeenCalledExactlyOnceWith({ kind: 'local' }, 'upNext.list', {
    conversationId: source
  })
})

it('keeps the chosen Save folder in the host draft at commit', async () => {
  const done = {
    kind: 'done',
    id: 'done',
    state: 'draft',
    number: '1',
    locked: false,
    finish: 'close'
  } as const
  const view = { ...upNextFixture(), blocks: [done] }
  vi.mocked(callRuntimeRpc).mockImplementation(async (_, method, params) => {
    if (method === 'upNext.update') {
      Object.assign(done, (params as { patch: object }).patch)
    }
    if (method === 'upNext.commit') {
      expect(done).toMatchObject({ finish: 'save', folderId: 'folder-1' })
    }
    return { view }
  })
  const { result } = renderHook(() => useUpNext(view.conversationId))
  await waitFor(() => expect(result.current.view).toEqual(view))
  await act(async () => {
    await result.current.update('done', { kind: 'done', finish: 'save', folderId: 'folder-1' })
    expect(await result.current.commit()).toBe(true)
  })
})

it('follows adopted drafts after refusal and retries without another launch', async () => {
  const subject = { kind: 'thread', threadId: 'thread' } as const
  const source = { kind: 'pty', worktreeId: 'w', paneKey: 'p' } as const
  let fail = true
  vi.mocked(callRuntimeRpc).mockImplementation(async (_, method, params) => {
    if (method === 'upNext.commit' && fail) {
      fail = false
      throw new Error(UP_NEXT_REFUSAL_KEYS.needsPerson)
    }
    return {
      view: {
        ...upNextFixture(),
        conversationId: (params as { conversationId: typeof source }).conversationId
      }
    }
  })
  const start = vi.fn(async () => source)
  const { result } = renderHook(() => useUpNext(subject, undefined, { start }))
  await waitFor(() => expect(result.current.view).not.toBeNull())
  await act(async () => {
    expect(await result.current.commit()).toBe(false)
  })
  expect(result.current.view?.conversationId).toEqual(source)
  expect(result.current.error).toBe(en.upNext.refusal.needsPerson)
  await act(async () => {
    expect(await result.current.commit()).toBe(true)
  })
  expect(start).toHaveBeenCalledTimes(1)
  expect(callRuntimeRpc).toHaveBeenLastCalledWith({ kind: 'local' }, 'upNext.list', {
    conversationId: source
  })
  expect(
    vi.mocked(callRuntimeRpc).mock.calls.findLast((call) => call[1] === 'upNext.commit')?.[2]
  ).toEqual({ conversationId: source })
})

it('keeps drafts on the subject when a host refuses before adoption', async () => {
  const subject = { kind: 'card', taskId: 'task' } as const
  const source = { kind: 'pty', worktreeId: 'w', paneKey: 'p' } as const
  const original = { ...upNextFixture(), conversationId: subject, draftCount: 1 }
  vi.mocked(callRuntimeRpc).mockImplementation(async (_, method, params) => {
    if (method === 'upNext.commit') {
      throw new Error('unsupported')
    }
    return {
      view:
        (params as { conversationId: { kind: string } }).conversationId.kind === 'card'
          ? original
          : { ...upNextFixture(), conversationId: source }
    }
  })
  const start = vi.fn(async () => source)
  const { result } = renderHook(() => useUpNext(subject, undefined, { start }))
  await waitFor(() => expect(result.current.view).toEqual(original))
  await act(async () => {
    expect(await result.current.commit()).toBe(false)
  })
  expect(result.current.view).toEqual(original)
  await act(async () => {
    expect(await result.current.commit()).toBe(false)
  })
  expect(start).toHaveBeenCalledTimes(1)
})
