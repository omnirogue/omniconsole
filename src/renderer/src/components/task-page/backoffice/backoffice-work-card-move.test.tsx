// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { WorkCard } from '../../../../../shared/console-work-home-contract'
import { BackofficeWorkCardMove } from './backoffice-work-card-move'

const api = vi.hoisted(() => ({ transitionTask: vi.fn(), getTask: vi.fn(), updateTask: vi.fn() }))
vi.mock('@/lib/console-workflow-client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  consoleWorkflowApi: () => api
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), message: vi.fn() } }))
// Why passthrough: this asserts which verb a column sends, not Radix's own menu behaviour.
vi.mock('@/components/ui/dropdown-menu', () => {
  const pass = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
  return {
    DropdownMenu: pass,
    DropdownMenuContent: pass,
    DropdownMenuTrigger: pass,
    DropdownMenuItem: ({
      children,
      onSelect,
      ...rest
    }: {
      children?: React.ReactNode
      onSelect?: () => void
    }) => (
      <button type="button" onClick={onSelect} {...rest}>
        {children}
      </button>
    )
  }
})

const card: WorkCard = {
  id: 'btk_alpha0001',
  title: 'Ship Alpha',
  status: 'waiting',
  kanban_eligible: true,
  source: 'omniconsole-ide'
} as WorkCard
const todo = { task_id: card.id, title: card.title, state_revision: 3 } as never
const onMoved = vi.fn()

function mount(overrides: Partial<Parameters<typeof BackofficeWorkCardMove>[0]> = {}) {
  return render(
    <BackofficeWorkCardMove
      card={card}
      column="waiting"
      todo={todo}
      onMoved={onMoved}
      {...overrides}
    />
  )
}

const refused = (code: string, message: string) => ({
  ok: false as const,
  error: { code, message, status: 409 }
})

afterEach(cleanup)
beforeEach(() => {
  api.transitionTask.mockReset()
  api.getTask.mockReset()
  api.updateTask.mockReset()
  onMoved.mockReset()
})

const freshCard = (state_revision: number, tags: string[]) => ({
  ok: true,
  data: { id: card.id, state_revision, tags }
})

it('commits a proposal from a fresh read: untag with the hub’s tags, then the verb with the advanced revision', async () => {
  api.updateTask.mockResolvedValue({ ok: true, data: { ok: true } })
  // Why: the board projection says ['proposed'] but the hub already holds another tag.
  api.getTask
    .mockResolvedValueOnce(freshCard(7, ['proposed', 'company:gamma']))
    .mockResolvedValueOnce(freshCard(8, ['company:gamma']))
  api.transitionTask.mockResolvedValue({ ok: true, data: {} })
  mount({
    card: { ...card, status: 'pending', kanban_status: 'backlog', tags: ['proposed'] },
    column: 'proposed'
  })
  pick('ready')
  await waitFor(() => expect(onMoved).toHaveBeenCalled())
  expect(api.updateTask).toHaveBeenCalledWith({
    taskId: card.id,
    expectedRevision: 7,
    tags: ['company:gamma']
  })
  expect(api.transitionTask).toHaveBeenCalledWith({
    taskId: card.id,
    action: 'ready',
    expectedRevision: 8
  })
})

it('needs no verb when a proposal leaves for the lane it already stands in', async () => {
  api.updateTask.mockResolvedValue({ ok: true, data: { ok: true } })
  api.getTask.mockResolvedValue(freshCard(3, ['proposed']))
  mount({
    card: { ...card, status: 'open', kanban_status: 'ready', tags: ['proposed'] },
    column: 'proposed'
  })
  pick('ready')
  await waitFor(() => expect(onMoved).toHaveBeenCalled())
  expect(api.updateTask).toHaveBeenCalledWith({ taskId: card.id, expectedRevision: 3, tags: [] })
  expect(api.transitionTask).not.toHaveBeenCalled()
})

it('parks a card as a proposal with one tag write and no verb', async () => {
  api.updateTask.mockResolvedValue({ ok: true, data: { ok: true } })
  api.getTask.mockResolvedValue(freshCard(3, ['company:beta']))
  mount({ card: { ...card, status: 'open', tags: [] }, column: 'ready' })
  pick('proposed')
  await waitFor(() => expect(onMoved).toHaveBeenCalled())
  expect(api.updateTask).toHaveBeenCalledWith({
    taskId: card.id,
    expectedRevision: 3,
    tags: ['proposed', 'company:beta']
  })
  expect(api.transitionTask).not.toHaveBeenCalled()
})

it('puts the tag back when the hub refuses the verb after the untag landed', async () => {
  api.updateTask.mockResolvedValue({ ok: true, data: { ok: true } })
  api.getTask
    .mockResolvedValueOnce(freshCard(7, ['proposed']))
    .mockResolvedValueOnce(freshCard(8, []))
    .mockResolvedValueOnce(freshCard(8, []))
  api.transitionTask.mockResolvedValue(
    refused('canonical_lifecycle_required', 'Close the open review first.')
  )
  mount({
    card: { ...card, status: 'pending', kanban_status: 'backlog', tags: ['proposed'] },
    column: 'proposed'
  })
  pick('ready')
  await waitFor(() =>
    expect(screen.getByRole('alert').textContent).toBe('Close the open review first.')
  )
  expect(api.updateTask).toHaveBeenNthCalledWith(1, {
    taskId: card.id,
    expectedRevision: 7,
    tags: []
  })
  expect(api.updateTask).toHaveBeenNthCalledWith(2, {
    taskId: card.id,
    expectedRevision: 8,
    tags: ['proposed']
  })
  expect(onMoved).not.toHaveBeenCalled()
})

it('retries a stale move from a fresh read instead of replaying the old tag list', async () => {
  api.updateTask
    .mockResolvedValueOnce(refused('stale_revision', 'Refresh card'))
    .mockResolvedValueOnce({ ok: true, data: { ok: true } })
  api.getTask
    .mockResolvedValueOnce(freshCard(3, ['proposed']))
    .mockResolvedValueOnce(freshCard(4, ['proposed', 'company:gamma']))
  mount({
    card: { ...card, status: 'open', kanban_status: 'ready', tags: ['proposed'] },
    column: 'proposed'
  })
  pick('ready')
  await waitFor(() => expect(onMoved).toHaveBeenCalledTimes(1))
  expect(api.updateTask).toHaveBeenLastCalledWith({
    taskId: card.id,
    expectedRevision: 4,
    tags: ['company:gamma']
  })
})

it('does not move a proposal the hub calls ineligible: it was filed outside this app', () => {
  mount({
    card: { ...card, source: 'omni-console', kanban_eligible: false, tags: ['proposed'] },
    column: 'proposed'
  })
  expect(document.querySelector('[data-work-card-move]')).toBeNull()
  expect(document.querySelector('[data-work-card-move-blocked]')).toBeTruthy()
})

const pick = (state: string) =>
  fireEvent.click(document.querySelector(`[data-work-card-move-target="${state}"]`)!)

it('resumes a waiting card with the revision its row reported', async () => {
  api.transitionTask.mockResolvedValue({ ok: true, data: {} })
  mount()
  pick('in-progress')
  fireEvent.change(await screen.findByLabelText('Reason'), { target: { value: 'Access restored' } })
  fireEvent.click(screen.getByRole('button', { name: 'Move task' }))
  await waitFor(() => expect(onMoved).toHaveBeenCalled())
  expect(api.transitionTask).toHaveBeenCalledWith({
    taskId: 'btk_alpha0001',
    action: 'resume',
    expectedRevision: 3,
    reason: 'Access restored'
  })
})

it('keeps the card and repeats the hub when the canonical rail refuses the move', async () => {
  api.transitionTask.mockResolvedValue(
    refused('canonical_lifecycle_required', 'Close the open review first.')
  )
  mount()
  pick('ready')
  expect((await screen.findByRole('alert')).textContent).toContain('Close the open review first.')
  expect(api.transitionTask).toHaveBeenCalledTimes(1)
  expect(onMoved).not.toHaveBeenCalled()
})

it.each(['card-not-ours', 'card-ownership-unknown'])(
  'never retries a card another console owns (%s)',
  async (code) => {
    api.transitionTask.mockResolvedValue(refused(code, 'not yours'))
    mount()
    pick('ready')
    expect((await screen.findByRole('alert')).textContent).toContain(
      'This task is managed from another console.'
    )
    expect(api.transitionTask).toHaveBeenCalledTimes(1)
    expect(api.getTask).not.toHaveBeenCalled()
  }
)

it('re-reads the revision once and retries when the expected one was stale', async () => {
  api.transitionTask
    .mockResolvedValueOnce(refused('stale_snapshot', 'stored seq is 4'))
    .mockResolvedValueOnce({ ok: true, data: {} })
  api.getTask.mockResolvedValue({ ok: true, data: { id: card.id, state_revision: 4 } })
  mount()
  pick('ready')
  await waitFor(() => expect(api.transitionTask).toHaveBeenCalledTimes(2))
  expect(api.transitionTask.mock.calls[1]![0]).toMatchObject({ expectedRevision: 4 })
  expect(screen.queryByRole('alert')).toBeNull()
})

it('surfaces the refusal when the retry hits the same conflict', async () => {
  api.transitionTask.mockResolvedValue(refused('stale_snapshot', 'stored seq is 4'))
  api.getTask.mockResolvedValue({ ok: true, data: { id: card.id, state_revision: 4 } })
  mount()
  pick('ready')
  expect((await screen.findByRole('alert')).textContent).toContain('re-read')
  expect(api.transitionTask).toHaveBeenCalledTimes(2)
})

it('offers no move on an ineligible card, and says why in the hub words', () => {
  mount({
    card: { ...card, kanban_eligible: false, kanban_reason: 'Created in the web console.' }
  })
  expect(document.querySelector('[data-work-card-move]')).toBeNull()
  expect(screen.getByText('Created in the web console.')).toBeTruthy()
})

it('never retries a lifecycle conflict and restores Proposed without losing concurrent tags', async () => {
  api.updateTask.mockResolvedValue({ ok: true, data: {} })
  api.getTask
    .mockResolvedValueOnce(freshCard(7, ['Proposed', 'company:alpha']))
    .mockResolvedValueOnce(freshCard(8, ['company:alpha']))
    .mockResolvedValueOnce(freshCard(9, ['company:alpha', 'new-tag']))
  api.transitionTask.mockResolvedValue(
    refused('lifecycle_conflict', 'Resolve the active wait first.')
  )
  mount({
    card: { ...card, status: 'pending', kanban_status: 'backlog', tags: ['Proposed'] },
    column: 'proposed'
  })
  pick('ready')
  expect((await screen.findByRole('alert')).textContent).toBe('Resolve the active wait first.')
  expect(api.transitionTask).toHaveBeenCalledTimes(1)
  expect(api.updateTask).toHaveBeenCalledTimes(2)
  expect(api.updateTask).toHaveBeenLastCalledWith({
    taskId: card.id,
    expectedRevision: 9,
    tags: ['proposed', 'company:alpha', 'new-tag']
  })
})

it('restores Proposed when the post-untag read fails before the verb', async () => {
  api.updateTask.mockResolvedValue({ ok: true, data: {} })
  api.getTask
    .mockResolvedValueOnce(freshCard(7, ['proposed']))
    .mockRejectedValueOnce(new Error('Temporary network failure'))
    .mockResolvedValueOnce(freshCard(8, ['company:gamma']))
  mount({
    card: { ...card, status: 'pending', kanban_status: 'backlog', tags: ['proposed'] },
    column: 'proposed'
  })
  pick('ready')
  expect((await screen.findByRole('alert')).textContent).toBe('Temporary network failure')
  expect(api.transitionTask).not.toHaveBeenCalled()
  expect(api.updateTask).toHaveBeenCalledTimes(2)
  expect(api.updateTask).toHaveBeenLastCalledWith({
    taskId: card.id,
    expectedRevision: 8,
    tags: ['proposed', 'company:gamma']
  })
})

it('collects a wait reason and target before touching Proposed', async () => {
  api.updateTask.mockResolvedValue({ ok: true, data: {} })
  api.getTask.mockResolvedValue(freshCard(7, ['proposed']))
  api.transitionTask.mockResolvedValue({ ok: true, data: {} })
  mount({ card: { ...card, status: 'open', tags: ['proposed'] }, column: 'proposed' })
  pick('waiting')
  expect(api.updateTask).not.toHaveBeenCalled()
  fireEvent.change(await screen.findByLabelText('Reason'), {
    target: { value: 'Need credentials' }
  })
  expect((screen.getByRole('button', { name: 'Move task' }) as HTMLButtonElement).disabled).toBe(
    true
  )
  fireEvent.change(screen.getByLabelText('Waiting for'), { target: { value: 'Customer IT' } })
  fireEvent.click(screen.getByRole('button', { name: 'Move task' }))
  await waitFor(() => expect(onMoved).toHaveBeenCalled())
  expect(api.transitionTask).toHaveBeenCalledWith(
    expect.objectContaining({
      action: 'wait',
      reason: 'Need credentials',
      waitingOn: 'Customer IT'
    })
  )
})

it('submits review evidence and displays a validation refusal in the dialog', async () => {
  api.transitionTask.mockResolvedValue({
    ok: false,
    error: {
      code: 'lifecycle_validation',
      message: 'Evidence belongs to another task',
      status: 422
    }
  })
  mount({ column: 'in-progress' })
  pick('review')
  fireEvent.change(await screen.findByLabelText('Evidence'), {
    target: { value: 'https://example.com/pr/12' }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Move task' }))
  expect((await screen.findByRole('alert')).textContent).toBe('Evidence belongs to another task')
  expect(api.transitionTask).toHaveBeenCalledTimes(1)
  expect(api.transitionTask).toHaveBeenCalledWith(
    expect.objectContaining({ action: 'submit_for_review', resultRef: 'https://example.com/pr/12' })
  )
})
