// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { BackofficeWorkBoard } from './backoffice-work-board'
const api = vi.hoisted(() => ({ listWork: vi.fn() }))
vi.mock('@/lib/console-workflow-client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  consoleWorkflowApi: () => api
}))
const board = {
  items: [
    {
      id: 'btk_alpha0001',
      title: 'Ship Alpha',
      status: 'in_progress',
      source: 'omniconsole-ide',
      company_slug: 'alpha',
      org_unit_id: 'org_dev',
      owner_employee_id: 'emp_sal',
      next_action: 'Test candidate'
    },
    {
      id: 'btk_beta0001',
      title: 'Review Beta',
      status: 'awaiting_approval',
      source: 'omniconsole-ide',
      company_slug: 'beta',
      org_unit_id: 'org_ops'
    }
  ],
  total: 2,
  capped: false,
  companies: [
    {
      id: 'co_alpha',
      slug: 'alpha',
      name: 'Alpha',
      domains: [{ id: 'org_dev', name: 'Development' }]
    }
  ]
}
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})
beforeEach(() => {
  localStorage.clear()
  api.listWork.mockReset()
  api.listWork.mockResolvedValue({ ok: true, data: board })
})
const props = {
  scope: 'person-a',
  viewer: 'emp_sal',
  rows: [],
  names: new Map([['emp_sal', 'Sal']]),
  onOpenTask: vi.fn()
}
it('saves company and domain views and opens the original canonical task ID', async () => {
  const first = render(<BackofficeWorkBoard {...props} />)
  await screen.findByText('Ship Alpha')
  fireEvent.change(screen.getByLabelText('Company'), { target: { value: 'alpha' } })
  fireEvent.change(screen.getByLabelText('Domain'), { target: { value: 'org_dev' } })
  expect(screen.queryByText('Review Beta')).toBeNull()
  fireEvent.click(screen.getByText('Ship Alpha'))
  expect(props.onOpenTask).toHaveBeenCalledWith(
    'btk_alpha0001',
    expect.objectContaining({ id: 'btk_alpha0001' })
  )
  first.unmount()
  render(<BackofficeWorkBoard {...props} />)
  await screen.findByText('Ship Alpha')
  expect(screen.queryByText('Review Beta')).toBeNull()
  expect((screen.getByLabelText('Domain') as HTMLSelectElement).value).toBe('org_dev')
})
it('keeps source failures visible and removes rows when authority is refused', async () => {
  render(<BackofficeWorkBoard {...props} />)
  await screen.findByText('Ship Alpha')
  api.listWork.mockResolvedValue({
    ok: false,
    error: { code: 'forbidden', message: 'Access refused' }
  })
  fireEvent.click(screen.getByText('Refresh'))
  await screen.findByRole('alert')
  expect(screen.queryByText('Ship Alpha')).toBeNull()
})
it('refreshes another person’s update on focus', async () => {
  render(<BackofficeWorkBoard {...props} />)
  await screen.findByText('Ship Alpha')
  api.listWork.mockResolvedValue({
    ok: true,
    data: { ...board, items: [{ ...board.items[0], title: 'Alpha reviewed' }] }
  })
  fireEvent(window, new Event('focus'))
  await screen.findByText('Alpha reviewed')
  expect(screen.queryByText('Ship Alpha')).toBeNull()
})
it('shows partial coverage rather than presenting a capped feed as complete', async () => {
  api.listWork.mockResolvedValue({ ok: true, data: { ...board, total: 2000, capped: true } })
  render(<BackofficeWorkBoard {...props} />)
  await waitFor(() => expect(screen.getByText(/Partial board:/).textContent).toContain('2000'))
})

it('shows six outcome columns while failures and concurrent sessions remain badges', async () => {
  const cards = [
    {
      id: 'btk_backlog1',
      title: 'Accepted for later',
      status: 'pending',
      kanban_status: 'backlog'
    },
    { id: 'btk_ready001', title: 'Actionable work', status: 'open', kanban_status: 'ready' },
    {
      id: 'btk_running1',
      title: 'Deliver one outcome',
      status: 'running',
      execution_state: 'FAILED',
      kanban_status: 'in_progress',
      kanban_badges: [
        { kind: 'sessions', label: '3 sessions', count: 3 },
        { kind: 'failed_attempt', label: 'Failed attempt' }
      ]
    },
    {
      id: 'btk_waiting1',
      title: 'Need API access',
      status: 'awaiting_approval',
      kanban_status: 'waiting',
      kanban_reason: 'Access grant pending'
    },
    {
      id: 'btk_review01',
      title: 'Check the candidate',
      status: 'candidate_complete',
      kanban_status: 'review'
    },
    {
      id: 'btk_done0001',
      title: 'Verified outcome',
      status: 'verified_complete',
      kanban_status: 'done'
    }
  ]
  api.listWork.mockResolvedValue({
    ok: true,
    data: {
      ...board,
      items: cards.map((card) => ({
        ...card,
        source: 'omniconsole-ide',
        owner_employee_id: 'emp_sal'
      })),
      total: cards.length
    }
  })
  const { container } = render(<BackofficeWorkBoard {...props} />)
  await screen.findByText('Deliver one outcome')
  expect(
    [...container.querySelectorAll('[data-work-column] h3')].map((node) => node.textContent)
  ).toEqual([
    'Proposed · 0',
    'Backlog · 1',
    'Ready · 1',
    'In Progress · 1',
    'Waiting · 1',
    'Review · 1',
    'Done · 1'
  ])
  const active = container.querySelector('[data-work-column="in-progress"]') as HTMLElement
  expect(within(active).getByText('3 sessions')).toBeTruthy()
  expect(within(active).getByText('Failed attempt')).toBeTruthy()
  expect(within(active).getByText('Deliver one outcome')).toBeTruthy()
  expect(
    within(container.querySelector('[data-work-column="review"]') as HTMLElement).getByText(
      'Check the candidate'
    )
  ).toBeTruthy()
  expect(screen.getByText('Waiting: Access grant pending')).toBeTruthy()
  expect(screen.queryByRole('heading', { name: /^Failed/ })).toBeNull()
})

it('keeps subtasks, untriaged and cancelled records outside the parent outcome board and available in List', async () => {
  api.listWork.mockResolvedValue({
    ok: true,
    data: {
      ...board,
      items: [
        {
          id: 'btk_cancel01',
          title: 'Cancelled request',
          status: 'cancelled',
          kanban_disposition: 'cancelled'
        },
        { id: 'btk_capture1', title: 'Incoming request', status: 'open', triage_state: 'inbox' },
        {
          id: 'btk_child001',
          title: 'Check one part',
          status: 'running',
          kanban_status: 'in_progress',
          source: 'omniconsole-ide',
          parent_task_id: 'btk_parent01'
        },
        {
          id: 'btk_plumbing',
          title: 'Messaging support record',
          status: 'open',
          source: 'omni-console'
        }
      ]
    }
  })
  const { container } = render(<BackofficeWorkBoard {...props} />)
  fireEvent.change(screen.getByLabelText('Task owner'), { target: { value: 'visible' } })
  await screen.findByText('View other work and closed records in List')
  expect(container.querySelectorAll('[data-work-card]')).toHaveLength(0)
  fireEvent.change(screen.getByLabelText('Task owner'), { target: { value: 'visible' } })
  fireEvent.click(screen.getByRole('button', { name: /^List$/ }))
  expect(screen.getByText('Cancelled request')).toBeTruthy()
  expect(screen.getByText('Incoming request')).toBeTruthy()
  expect(screen.getByText('Check one part')).toBeTruthy()
  expect(screen.getByText('Messaging support record')).toBeTruthy()
})

it('defaults to the mapped employee’s own parent tasks and widens only on an explicit choice', async () => {
  render(<BackofficeWorkBoard {...props} />)
  await screen.findByText('Ship Alpha')
  expect(screen.queryByText('Review Beta')).toBeNull()
  fireEvent.change(screen.getByLabelText('Task owner'), { target: { value: 'visible' } })
  expect(screen.getByText('Review Beta')).toBeTruthy()
})

it('does not widen the personal Kanban while employee identity is unavailable', async () => {
  render(<BackofficeWorkBoard {...props} viewer={null} />)
  await waitFor(() => expect(api.listWork).toHaveBeenCalled())
  expect(screen.queryByText('Ship Alpha')).toBeNull()
  expect(screen.getByText(/Your employee identity is not available/)).toBeTruthy()
})

it('shows the owner, assigned actors, outcome and due date together on the card', async () => {
  api.listWork.mockResolvedValue({
    ok: true,
    data: {
      ...board,
      items: [
        {
          ...board.items[0],
          actors: [{ id: 'emp_gamma', role: 'implementation' }],
          acceptance_criteria: 'Release is live with verified signup flow',
          due_date: '2026-09-20',
          task_plan: {
            version: 1,
            steps: [],
            completion_mode: 'deployment',
            deployment_target: 'Production'
          }
        }
      ]
    }
  })
  render(
    <BackofficeWorkBoard
      {...props}
      names={
        new Map([
          ['emp_sal', 'Sal'],
          ['emp_gamma', 'Gamma']
        ])
      }
    />
  )
  await screen.findByText('Ship Alpha')
  expect(screen.getByText('Owner: Sal')).toBeTruthy()
  expect(screen.getByText('People: Gamma')).toBeTruthy()
  expect(screen.getByText('Outcome: Release is live with verified signup flow')).toBeTruthy()
  expect(screen.getByText(/Due 2026-09-20/)).toBeTruthy()
  expect(screen.getByText('Deployment Production')).toBeTruthy()
})

it('lands proposals on the Proposed lane whichever chat filed them, and names every company', async () => {
  api.listWork.mockResolvedValue({
    ok: true,
    data: {
      ...board,
      companies: [
        ...board.companies,
        { id: 'co_beta', slug: 'beta', name: 'Beta Co', domains: [] }
      ],
      items: [
        {
          id: 'btk_idea0001',
          title: 'Unlimited toggle',
          status: 'open',
          kanban_status: 'ready',
          // Why: the omnios MCP files with the console's own source, which the hub calls ineligible.
          source: 'omni-console',
          kanban_eligible: false,
          company_slug: 'alpha',
          org_unit_id: 'org_dev',
          owner_employee_id: 'emp_sal',
          description: 'Let a customer switch the plan to unlimited from the account page.',
          tags: ['proposed', 'company:beta']
        },
        {
          id: 'btk_started1',
          title: 'Already started idea',
          status: 'in_progress',
          kanban_status: 'in_progress',
          source: 'omniconsole-ide',
          company_slug: 'alpha',
          owner_employee_id: 'emp_sal',
          tags: ['proposed']
        }
      ],
      total: 2
    }
  })
  const { container } = render(<BackofficeWorkBoard {...props} />)
  await screen.findByText('Unlimited toggle')
  const proposed = container.querySelector('[data-work-column="proposed"]') as HTMLElement
  expect(within(proposed).getByText('Unlimited toggle')).toBeTruthy()
  expect(within(proposed).getByText('Alpha')).toBeTruthy()
  expect(within(proposed).getByText('Beta Co')).toBeTruthy()
  expect(within(proposed).getByText('· Development')).toBeTruthy()
  expect(
    within(proposed).getByText('Let a customer switch the plan to unlimited from the account page.')
  ).toBeTruthy()
  // A proposal already in progress shows where the work is, wearing the Proposed badge.
  const active = container.querySelector('[data-work-column="in-progress"]') as HTMLElement
  expect(within(active).getByText('Already started idea')).toBeTruthy()
  expect(within(active).getByText('Proposed')).toBeTruthy()
  // The company filter finds a card through any of its companies.
  fireEvent.change(screen.getByLabelText('Company'), { target: { value: 'beta' } })
  expect(screen.getByText('Unlimited toggle')).toBeTruthy()
  expect(screen.queryByText('Already started idea')).toBeNull()
  expect(screen.getByRole('button', { name: 'Propose' })).toBeTruthy()
})

it('keeps an accepted proposal from chat on the board and matches mixed-case slugs to their names', async () => {
  api.listWork.mockResolvedValue({
    ok: true,
    data: {
      ...board,
      companies: [{ id: 'co_sway', slug: 'BetaCorp', name: 'BetaCorp Inc.', domains: [] }],
      items: [
        {
          id: 'btk_accept01',
          title: 'Accepted idea',
          status: 'open',
          kanban_status: 'ready',
          // Why: propose_task files with this source, so the hub keeps it eligible once untagged.
          source: 'omniconsole-task',
          kanban_eligible: true,
          company_slug: 'BetaCorp',
          owner_employee_id: 'emp_sal',
          tags: []
        }
      ],
      total: 1
    }
  })
  const { container } = render(<BackofficeWorkBoard {...props} />)
  await screen.findByText('Accepted idea')
  const ready = container.querySelector('[data-work-column="ready"]') as HTMLElement
  expect(within(ready).getByText('Accepted idea')).toBeTruthy()
  expect(within(ready).getByText('BetaCorp Inc.')).toBeTruthy()
  const options = [...(screen.getByLabelText('Company') as HTMLSelectElement).options].map(
    (option) => option.value
  )
  expect(options).toEqual(['', 'betacorp'])
})

it('offers a direct edit action for the original task without opening another view', async () => {
  const onEditTask = vi.fn()
  const { container } = render(<BackofficeWorkBoard {...props} onEditTask={onEditTask} />)
  await screen.findByText('Ship Alpha')
  const card = container.querySelector('[data-work-card="btk_alpha0001"]') as HTMLElement
  fireEvent.click(
    within(card.parentElement as HTMLElement).getByRole('button', { name: 'Edit task' })
  )
  expect(onEditTask).toHaveBeenCalledWith(
    'btk_alpha0001',
    expect.objectContaining({ id: 'btk_alpha0001' })
  )
})

it('retains the last successful board when a refresh fails transiently', async () => {
  render(<BackofficeWorkBoard {...props} />)
  await screen.findByText('Ship Alpha')
  api.listWork.mockRejectedValue(new Error('Network unavailable'))
  fireEvent.click(screen.getByText('Refresh'))
  expect((await screen.findByRole('alert')).textContent).toContain('Network unavailable')
  expect(screen.getByText('Ship Alpha')).toBeTruthy()
})

it('normalizes old saved company filters and warns once when tags are absent', async () => {
  localStorage.setItem('work-home:person-a', JSON.stringify({ company: ' Alpha ' }))
  render(<BackofficeWorkBoard {...props} />)
  await screen.findByText('Ship Alpha')
  expect((screen.getByLabelText('Company') as HTMLSelectElement).value).toBe('alpha')
  expect(
    screen.getAllByText('Console does not report tags; Proposed lane unavailable')
  ).toHaveLength(1)
})

it('shows other visible owners’ proposals with My tasks selected', async () => {
  api.listWork.mockResolvedValue({
    ok: true,
    data: {
      ...board,
      items: [
        ...board.items,
        {
          ...board.items[1],
          id: 'btk_proposal',
          title: 'Shared idea',
          tags: ['Proposed'],
          owner_employee_id: 'emp_other',
          status: 'pending',
          kanban_status: 'backlog'
        }
      ]
    }
  })
  render(<BackofficeWorkBoard {...props} />)
  await screen.findByText('Shared idea')
  expect(screen.getByText('Ship Alpha')).toBeTruthy()
  expect(screen.queryByText('Review Beta')).toBeNull()
})
