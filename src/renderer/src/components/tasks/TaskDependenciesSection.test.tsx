// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TaskDependenciesSection } from './TaskDependenciesSection'

const api = vi.hoisted(() => ({
  listTaskDependencies: vi.fn(),
  addTaskDependency: vi.fn(),
  removeTaskDependency: vi.fn(),
  listWork: vi.fn()
}))
vi.mock('@/lib/console-workflow-client', async (original) => ({
  ...(await original<object>()),
  consoleWorkflowApi: () => api
}))
afterEach(cleanup)

const upstream = {
  task_id: 'btk_prereq01',
  title: 'Prepare data',
  status: 'cancelled',
  condition: 'DONE',
  state: 'unmeetable',
  reason: "Depends on 'Prepare data', which was cancelled",
  created_by: 'emp_sal'
}
const downstream = {
  task_id: 'btk_after001',
  title: 'Publish report',
  status: 'ready',
  condition: 'VERIFIED',
  state: 'waiting',
  reason: "'Publish report' is waiting for this task to be verified",
  created_by: 'emp_sal'
}
beforeEach(() => {
  vi.clearAllMocks()
  api.listTaskDependencies.mockResolvedValue({
    ok: true,
    data: { task_id: 'btk_card0001', depends_on: [upstream], dependents: [downstream] }
  })
  api.listWork.mockResolvedValue({
    ok: true,
    data: {
      items: [
        { id: 'btk_card0001', title: 'This task', status: 'ready' },
        { id: 'btk_prereq01', title: 'Prepare data', status: 'ready' },
        { id: 'btk_after001', title: 'Publish report', status: 'ready' },
        { id: 'btk_new00001', title: 'Review copy', status: 'ready' }
      ],
      total: 4,
      capped: false
    }
  })
})

function rows(label: string) {
  return screen.getByText(label).parentElement!
}

it('lists what the task depends on and what it blocks, with state and reason', async () => {
  const onOpenTask = vi.fn()
  render(<TaskDependenciesSection taskId="btk_card0001" onOpenTask={onOpenTask} />)
  await screen.findByText('Prepare data')
  const up = within(rows('Depends on'))
  expect(up.getByText("Can't be met")).toBeTruthy()
  expect(up.getByText("Depends on 'Prepare data', which was cancelled")).toBeTruthy()
  const down = within(rows('Blocks'))
  expect(down.getByText('Waiting')).toBeTruthy()
  expect(down.getByText('when verified')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Publish report' }))
  expect(onOpenTask).toHaveBeenCalledWith('btk_after001')
})

it('adds through the picker optimistically, excluding the task and its linked tasks', async () => {
  let finish!: (value: unknown) => void
  api.addTaskDependency.mockReturnValue(new Promise((resolve) => (finish = resolve)))
  render(<TaskDependenciesSection taskId="btk_card0001" />)
  await screen.findByText('Prepare data')
  fireEvent.click(screen.getByRole('button', { name: 'Add dependency' }))
  await waitFor(() =>
    expect(document.querySelector('[data-dependency-candidate="btk_new00001"]')).toBeTruthy()
  )
  for (const excluded of ['btk_card0001', 'btk_prereq01', 'btk_after001']) {
    expect(document.querySelector(`[data-dependency-candidate="${excluded}"]`)).toBeNull()
  }
  fireEvent.click(screen.getByRole('button', { name: 'when verified' }))
  fireEvent.click(document.querySelector('[data-dependency-candidate="btk_new00001"]')!)
  expect(api.addTaskDependency).toHaveBeenCalledWith({
    taskId: 'btk_card0001',
    dependsOnTaskId: 'btk_new00001',
    condition: 'VERIFIED'
  })
  await screen.findByText('Review copy')
  finish({
    ok: true,
    data: {
      ...upstream,
      task_id: 'btk_new00001',
      title: 'Review copy',
      state: 'waiting',
      reason: null
    }
  })
  await waitFor(() => expect(screen.getAllByText('Review copy')).toHaveLength(1))
})

it('rolls an add back and explains a cycle refusal', async () => {
  api.addTaskDependency.mockResolvedValue({
    ok: false,
    error: { code: 'dependency_cycle', status: 400, message: 'cycle' }
  })
  render(<TaskDependenciesSection taskId="btk_card0001" />)
  await screen.findByText('Prepare data')
  fireEvent.click(screen.getByRole('button', { name: 'Add dependency' }))
  await waitFor(() =>
    expect(document.querySelector('[data-dependency-candidate="btk_new00001"]')).toBeTruthy()
  )
  fireEvent.click(document.querySelector('[data-dependency-candidate="btk_new00001"]')!)
  await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/wait on each other/))
  expect(document.querySelector('[data-task-dependency="btk_new00001"]')).toBeNull()
})

it('removes only after confirmation, and restores the row when refused', async () => {
  api.removeTaskDependency.mockResolvedValue({
    ok: false,
    error: { code: 'card-not-ours', status: 409, message: 'not ours' }
  })
  render(<TaskDependenciesSection taskId="btk_card0001" />)
  await screen.findByText('Prepare data')
  fireEvent.click(screen.getByRole('button', { name: 'Remove dependency on Prepare data' }))
  expect(api.removeTaskDependency).not.toHaveBeenCalled()
  fireEvent.click(await screen.findByRole('button', { name: 'Remove' }))
  expect(api.removeTaskDependency).toHaveBeenCalledWith({
    taskId: 'btk_card0001',
    dependsOnTaskId: 'btk_prereq01'
  })
  await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/another console/))
  expect(document.querySelector('[data-task-dependency="btk_prereq01"]')).toBeTruthy()
})

it('shows a restricted edge as a count, never its id or state', async () => {
  api.listTaskDependencies.mockResolvedValue({
    ok: true,
    data: {
      task_id: 'btk_card0001',
      depends_on: [
        upstream,
        { ...upstream, task_id: 'btk_secret01', title: null, reason: null, restricted: true }
      ],
      dependents: [{ ...downstream, task_id: 'btk_secret02', title: null, restricted: true }]
    }
  })
  render(<TaskDependenciesSection taskId="btk_card0001" />)
  await screen.findByText('Prepare data')
  expect(screen.getByText("1 more you cannot open, and at least one can't be met")).toBeTruthy()
  expect(screen.getByText('1 more you cannot open')).toBeTruthy()
  expect(document.body.innerHTML).not.toMatch(/btk_secret0/)
  expect(screen.getAllByText("Can't be met")).toHaveLength(1)
})

it('says a direction could not be read instead of showing it as empty, and reads again', async () => {
  api.listTaskDependencies.mockResolvedValueOnce({
    ok: true,
    data: { task_id: 'btk_card0001', depends_on: null, dependents: [] }
  })
  render(<TaskDependenciesSection taskId="btk_card0001" />)
  expect(await screen.findByText('What this task depends on could not be read.')).toBeTruthy()
  expect(screen.queryByText('This task does not wait on another task.')).toBeNull()
  expect(
    (screen.getByRole('button', { name: 'Add dependency' }) as HTMLButtonElement).disabled
  ).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Read again' }))
  await screen.findByText('Prepare data')
  expect(screen.queryByText('What this task depends on could not be read.')).toBeNull()
})

it('shows a task-list refusal inside the picker instead of loading forever', async () => {
  api.listWork.mockResolvedValue({
    ok: false,
    error: { code: 'timeout', status: 504, message: 'work list timed out' }
  })
  render(<TaskDependenciesSection taskId="btk_card0001" />)
  await screen.findByText('Prepare data')
  fireEvent.click(screen.getByRole('button', { name: 'Add dependency' }))
  const dialog = await screen.findByRole('dialog')
  expect(await within(dialog).findByText('work list timed out')).toBeTruthy()
  expect(within(dialog).queryByText('Reading your work…')).toBeNull()
})

it('disables Add with a reason on a task the hub will not accept dependency edits for', async () => {
  render(<TaskDependenciesSection taskId="btk_card0001" taskStatus="done" />)
  await screen.findByText('Prepare data')
  expect(
    (screen.getByRole('button', { name: 'Add dependency' }) as HTMLButtonElement).disabled
  ).toBe(true)
  expect(document.querySelector('[data-task-dependencies-add-refusal]')?.textContent).toMatch(
    /closed/
  )
  // Removal is untouched: the hub has no open-only rule on DELETE.
  expect(screen.getByRole('button', { name: 'Remove dependency on Prepare data' })).toBeTruthy()
})

it('leaves Add available on an open task', async () => {
  render(<TaskDependenciesSection taskId="btk_card0001" taskStatus="open" />)
  await screen.findByText('Prepare data')
  expect(
    (screen.getByRole('button', { name: 'Add dependency' }) as HTMLButtonElement).disabled
  ).toBe(false)
  expect(document.querySelector('[data-task-dependencies-add-refusal]')).toBeNull()
})

it('says the list was truncated and refuses to guess a safe task to add', async () => {
  api.listTaskDependencies.mockResolvedValue({
    ok: true,
    data: {
      task_id: 'btk_card0001',
      depends_on: [upstream],
      dependents: [downstream],
      truncated: true
    }
  })
  render(<TaskDependenciesSection taskId="btk_card0001" taskStatus="open" />)
  await screen.findByText('Prepare data')
  expect(document.querySelector('[data-task-dependencies-truncated]')).toBeTruthy()
  // Edge 51+ is linked but unseen, so offering "unlinked" tasks would guarantee dependency_exists.
  expect(
    (screen.getByRole('button', { name: 'Add dependency' }) as HTMLButtonElement).disabled
  ).toBe(true)
  expect(document.querySelector('[data-task-dependencies-add-refusal]')?.textContent).toMatch(
    /could not be read/
  )
})

it('shows an edge with no condition or state as unknown, never as met when done', async () => {
  api.listTaskDependencies.mockResolvedValue({
    ok: true,
    data: {
      task_id: 'btk_card0001',
      depends_on: [{ ...upstream, condition: null, state: null, reason: null, status: null }],
      dependents: []
    }
  })
  render(<TaskDependenciesSection taskId="btk_card0001" />)
  await screen.findByText('Prepare data')
  const row = document.querySelector('[data-task-dependency="btk_prereq01"]')!
  expect(within(row as HTMLElement).getByText('Unknown')).toBeTruthy()
  expect(within(row as HTMLElement).getByText('condition unknown')).toBeTruthy()
  expect(row.querySelector('[data-task-dependency-degraded]')).toBeTruthy()
  expect(document.body.textContent).not.toMatch(/when done/)
})

it('drops the row when a removal succeeds', async () => {
  api.removeTaskDependency.mockResolvedValue({ ok: true, data: { removed: true } })
  render(<TaskDependenciesSection taskId="btk_card0001" />)
  await screen.findByText('Prepare data')
  fireEvent.click(screen.getByRole('button', { name: 'Remove dependency on Prepare data' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Remove' }))
  await waitFor(() =>
    expect(document.querySelector('[data-task-dependency="btk_prereq01"]')).toBeNull()
  )
  expect(screen.queryByRole('alert')).toBeNull()
})
