// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WorkCardDependencyBadge } from './WorkCardDependencyBadge'

const api = vi.hoisted(() => ({ listTaskDependencies: vi.fn() }))
vi.mock('@/lib/console-workflow-client', async (original) => ({
  ...(await original<object>()),
  consoleWorkflowApi: () => api
}))
afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
  api.listTaskDependencies.mockResolvedValue({
    ok: true,
    data: {
      task_id: 'btk_card0001',
      depends_on: [
        {
          task_id: 'btk_done0001',
          title: 'Done one',
          condition: 'DONE',
          state: 'satisfied',
          reason: null
        },
        {
          task_id: 'btk_gone0001',
          title: 'Prepare data',
          condition: 'DONE',
          state: 'unmeetable',
          reason: "Depends on 'Prepare data', which was cancelled"
        }
      ],
      dependents: []
    }
  })
})

it('renders nothing without a summary or once every dependency is met', () => {
  const { container, rerender } = render(<WorkCardDependencyBadge card={{ id: 'btk_card0001' }} />)
  expect(container.innerHTML).toBe('')
  rerender(
    <WorkCardDependencyBadge
      card={{
        id: 'btk_card0001',
        dependency_summary: { waiting: 0, satisfied: 2, unmeetable: 0, missing: 0 }
      }}
    />
  )
  expect(container.innerHTML).toBe('')
})

it('says how many dependencies the card waits on without reading them', () => {
  render(
    <WorkCardDependencyBadge
      card={{
        id: 'btk_card0001',
        dependency_summary: { waiting: 3, satisfied: 0, unmeetable: 0, missing: 0 }
      }}
    />
  )
  expect(screen.getByText('Waiting on 3').getAttribute('data-work-dependency-badge')).toBe(
    'waiting'
  )
  expect(api.listTaskDependencies).not.toHaveBeenCalled()
})

it('says can’t proceed in the destructive tone and lists the blockers once opened', async () => {
  render(
    <WorkCardDependencyBadge
      card={{
        id: 'btk_card0001',
        dependency_summary: { waiting: 1, satisfied: 1, unmeetable: 1, missing: 0 }
      }}
    />
  )
  const badge = screen.getByText("Can't proceed")
  expect(badge.getAttribute('data-variant')).toBe('destructive')
  fireEvent.focus(badge)
  await waitFor(() => expect(api.listTaskDependencies).toHaveBeenCalledTimes(1))
  expect(api.listTaskDependencies).toHaveBeenCalledWith({ taskId: 'btk_card0001' })
  expect(await screen.findByText("Depends on 'Prepare data', which was cancelled")).toBeTruthy()
  expect(screen.queryByText('Done one')).toBeNull()
})

it('never shows a restricted blocker’s id or state, only a count', async () => {
  api.listTaskDependencies.mockResolvedValue({
    ok: true,
    data: {
      task_id: 'btk_card0001',
      depends_on: [
        {
          task_id: 'btk_secret01',
          title: null,
          condition: 'DONE',
          state: 'unmeetable',
          reason: null,
          restricted: true
        }
      ],
      dependents: []
    }
  })
  render(
    <WorkCardDependencyBadge
      card={{
        id: 'btk_card0001',
        dependency_summary: { waiting: 0, satisfied: 0, unmeetable: 1, missing: 0 }
      }}
    />
  )
  fireEvent.focus(screen.getByText("Can't proceed"))
  expect(await screen.findByText('1 more you cannot open')).toBeTruthy()
  expect(document.body.textContent).not.toMatch(/btk_secret01|Can't be met/)
})

it('says unknown when a count could not be read', () => {
  render(
    <WorkCardDependencyBadge
      card={{
        id: 'btk_card0001',
        dependency_summary: { waiting: null, satisfied: 0, unmeetable: 0, missing: 0 }
      }}
    />
  )
  expect(screen.getByText('Dependencies unknown').getAttribute('data-work-dependency-badge')).toBe(
    'unknown'
  )
})

it('says unknown when the whole summary could not be read, and nothing when it is absent', () => {
  const { container, rerender } = render(
    <WorkCardDependencyBadge card={{ id: 'btk_card0001', dependency_summary: null }} />
  )
  expect(screen.getByText('Dependencies unknown').getAttribute('data-work-dependency-badge')).toBe(
    'unknown'
  )
  rerender(<WorkCardDependencyBadge card={{ id: 'btk_card0001' }} />)
  expect(container.innerHTML).toBe('')
})

it('keeps the hub’s cause-specific words on the badge', () => {
  render(
    <WorkCardDependencyBadge
      card={{
        id: 'btk_card0001',
        dependency_summary: { waiting: 0, satisfied: 0, unmeetable: 1, missing: 0 },
        kanban_badges: [
          { kind: 'dependency_unmeetable', label: "Can't proceed: dependency cancelled" }
        ]
      }}
    />
  )
  expect(
    screen
      .getByText("Can't proceed: dependency cancelled")
      .getAttribute('data-work-dependency-badge')
  ).toBe('unmeetable')
})

it('re-reads a blocker that changed while the counts stayed the same', async () => {
  const summary = { waiting: 1, satisfied: 0, unmeetable: 0, missing: 0 }
  const blocker = (title: string) => ({
    ok: true,
    data: {
      task_id: 'btk_card0001',
      depends_on: [
        { task_id: 'btk_first001', title, condition: 'DONE', state: 'waiting', reason: null }
      ],
      dependents: []
    }
  })
  api.listTaskDependencies.mockResolvedValue(blocker('First blocker'))
  render(<WorkCardDependencyBadge card={{ id: 'btk_card0001', dependency_summary: summary }} />)
  const badge = () => document.querySelector('[data-work-dependency-badge]') as HTMLElement
  fireEvent.focus(badge())
  expect(await screen.findByText('First blocker')).toBeTruthy()
  fireEvent.blur(badge())
  // Radix closes 300ms after the blur; only then is the hover really shut.
  await waitFor(() => expect(screen.queryByText('First blocker')).toBeNull())
  // Same counts, different blocker: a cache kept across the close would freeze the first answer.
  api.listTaskDependencies.mockResolvedValue(blocker('Second blocker'))
  fireEvent.focus(badge())
  expect(await screen.findByText('Second blocker')).toBeTruthy()
  expect(api.listTaskDependencies).toHaveBeenCalledTimes(2)
})

it('says when the dependency list was truncated instead of showing a short list as whole', async () => {
  api.listTaskDependencies.mockResolvedValue({
    ok: true,
    data: {
      task_id: 'btk_card0001',
      depends_on: [
        {
          task_id: 'btk_wait0001',
          title: 'Waiting one',
          condition: 'DONE',
          state: 'waiting',
          reason: null
        }
      ],
      dependents: [],
      truncated: true
    }
  })
  render(
    <WorkCardDependencyBadge
      card={{
        id: 'btk_card0001',
        dependency_summary: { waiting: 60, satisfied: 0, unmeetable: 0, missing: 0 }
      }}
    />
  )
  fireEvent.focus(document.querySelector('[data-work-dependency-badge]') as HTMLElement)
  expect(
    await screen.findByText('Too many dependencies to list; open the task to see them all.')
  ).toBeTruthy()
})

it('re-reads the blockers after a refusal and after the card’s counts change', async () => {
  api.listTaskDependencies.mockResolvedValueOnce({
    ok: false,
    error: { code: 'timeout', status: 504, message: 'timed out' }
  })
  const summary = { waiting: 1, satisfied: 0, unmeetable: 0, missing: 0 }
  const { rerender } = render(
    <WorkCardDependencyBadge card={{ id: 'btk_card0001', dependency_summary: summary }} />
  )
  const badge = () => document.querySelector('[data-work-dependency-badge]') as HTMLElement
  fireEvent.focus(badge())
  expect(await screen.findByText('timed out')).toBeTruthy()
  fireEvent.blur(badge())
  await waitFor(() => expect(screen.queryByText('timed out')).toBeNull())
  fireEvent.focus(badge())
  await waitFor(() => expect(api.listTaskDependencies).toHaveBeenCalledTimes(2))
  fireEvent.blur(badge())
  await waitFor(() => expect(screen.queryByText('Prepare data')).toBeNull())
  rerender(
    <WorkCardDependencyBadge
      card={{ id: 'btk_card0001', dependency_summary: { ...summary, unmeetable: 1 } }}
    />
  )
  fireEvent.focus(badge())
  await waitFor(() => expect(api.listTaskDependencies).toHaveBeenCalledTimes(3))
})
