// @vitest-environment happy-dom
import { Profiler } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { WorkPlanComposerDialog } from './WorkPlanComposerDialog'
import { samWorkPlan } from '../../../../../shared/__fixtures__/work-plan/example-work-plan'
import { workPlanFixtureContext } from '../../../../../shared/__fixtures__/work-plan/work-plan-context'
import { workPlanFromShape } from '../../../../../shared/work-plan-shapes'
import {
  isWorkPlanWorkerNode,
  type WorkPlan,
  type WorkPlanContext
} from '../../../../../shared/work-plan-types'

vi.mock('@/components/ui/select', async () =>
  (await import('./work-plan-composer-test-doubles')).selectDouble()
)
vi.mock('@/components/ui/dialog', async () =>
  (await import('./work-plan-composer-test-doubles')).dialogDouble()
)

const ctx = workPlanFixtureContext()
/** Two agents, two families: enough to seat ×3 with a repeat, never enough for an independent judge. */
const thin: WorkPlanContext = workPlanFixtureContext({
  usableAgents: [
    { agent: 'claude', models: [{ id: 'opus-4', label: 'Opus', efforts: [] }] },
    { agent: 'codex', models: [{ id: 'gpt-5-codex', label: 'Codex', efforts: [] }] }
  ]
})
afterEach(cleanup)

function solo(host: WorkPlanContext = ctx): WorkPlan {
  return workPlanFromShape('solo', {
    prompt: 'Ship the launch page',
    outcome: samWorkPlan().outcome,
    planMode: false,
    ctx: host
  })
}

function open(
  host: WorkPlanContext = ctx,
  onRender?: () => void,
  container = document.createElement('div')
): HTMLElement {
  document.body.append(container)
  render(
    <Profiler id="composer" onRender={() => onRender?.()}>
      <WorkPlanComposerDialog
        capacity={3}
        ctx={host}
        onCancel={vi.fn()}
        onUse={vi.fn()}
        open
        plan={solo(host)}
      />
    </Profiler>,
    { container }
  )
  return container
}

const stage = (index: number): HTMLElement => screen.getAllByRole('listitem')[index - 1]!

it('never renders a chain, a count and a stage list that disagree', () => {
  const frames: string[] = []
  // The container exists BEFORE the first render, so the very first commit is checked too: an
  // initial render is exactly where a stale default would hide.
  const container = document.createElement('div')
  open(
    ctx,
    () => {
      const chain = container.querySelector('[aria-label="Live chain"]')
      if (!chain) {
        return
      }
      const stages = Number(chain.getAttribute('data-stages'))
      const notation = chain.querySelector('p')?.textContent ?? ''
      const summary = chain.querySelector('[aria-label="Chain summary"]')?.textContent ?? ''
      const drawn = notation.split(' → ').filter((step) => step !== '👤').length
      frames.push(`${stages}:${notation}:${summary}`)
      expect(drawn).toBe(stages)
      expect(summary).toContain(`${stages} workflow stages`)
      expect(container.querySelectorAll('[data-node-id]')).toHaveLength(stages)
    },
    container
  )
  expect(frames.length).toBeGreaterThanOrEqual(1)
  fireEvent.change(within(stage(1)).getByLabelText('Seats'), { target: { value: '3' } })
  fireEvent.click(within(stage(1)).getByRole('button', { name: 'Synthesize' }))
  fireEvent.click(within(stage(1)).getByRole('button', { name: 'Add stage after' }))
  expect(frames.length).toBeGreaterThan(3)
  expect(frames.at(-1)).toContain('agent executions')
})

it('shows a problem at the stage it names and refuses to hand over a blocked chain', () => {
  open()
  const verify = stage(2)
  fireEvent.click(
    within(verify).getByRole('checkbox', {
      name: 'Done When: the page states the offer and the price'
    })
  )
  fireEvent.click(
    within(verify).getByRole('checkbox', {
      name: 'Done When: three reviewers found nothing blocking'
    })
  )
  const alerts = within(stage(2))
    .getAllByRole('alert')
    .map((node) => node.textContent)
  expect(alerts.join(' ')).toContain('issues a verdict over nothing')
  expect(within(stage(1)).queryAllByRole('alert')).toHaveLength(0)
  expect(screen.getByRole('button', { name: 'Use this chain' })).toHaveProperty('disabled', true)
  expect(screen.getByLabelText('Chain summary').textContent).toContain('cannot run yet')
})

it('offers only the routes this build can run, and never a wait', () => {
  open()
  expect(screen.getAllByLabelText('Route')[0]?.textContent).toContain('New agent')
  expect(screen.queryByText(/same conversation/i)).toBeNull()
  expect(screen.queryByLabelText(/same conversation/i)).toBeNull()
  expect(screen.queryByText(/wait|snooze/i)).toBeNull()
  expect(screen.queryByLabelText(/wait|snooze/i)).toBeNull()
  // WHERE at the finish is the real v1 domain: the person, or nobody.
  expect(
    within(screen.getByLabelText('Finish'))
      .getAllByRole('option')
      .map((o) => o.textContent)
  ).toEqual(['Me · I decide', 'Complete on its own'])
  expect(screen.getByLabelText('Finish route').textContent).toBe('👤 Me')
})

it('seats ×N with distinct actors and shows the seat it had to repeat', () => {
  open(thin)
  fireEvent.change(within(stage(1)).getByLabelText('Seats'), { target: { value: '3' } })
  const seats = [1, 2, 3].map(
    (seat) => (within(stage(1)).getByLabelText(`Actor seat ${seat}`) as HTMLSelectElement).value
  )
  expect(new Set(seats.slice(0, 2)).size).toBe(2)
  expect(seats[2]).toBe(seats[0])
  expect(
    within(stage(1))
      .getAllByRole('alert')
      .map((node) => node.textContent)
      .join(' ')
  ).toContain('on more than one seat')
})

it('says why this host cannot judge its own candidates', () => {
  open(thin)
  fireEvent.change(within(stage(1)).getByLabelText('Seats'), { target: { value: '2' } })
  fireEvent.click(within(stage(1)).getByRole('button', { name: 'Judge' }))
  expect(
    within(stage(2))
      .getAllByRole('alert')
      .map((node) => node.textContent)
      .join(' ')
  ).toContain('you have 2 usable agents')
  expect(screen.getByRole('button', { name: 'Use this chain' })).toHaveProperty('disabled', true)
})

it('moves, duplicates and removes a stage without leaving a dangling reading edge', () => {
  const used: WorkPlan[] = []
  render(
    <WorkPlanComposerDialog
      capacity={3}
      ctx={ctx}
      onCancel={vi.fn()}
      onUse={(plan) => used.push(plan)}
      open
      plan={solo()}
    />
  )
  fireEvent.click(within(stage(1)).getByRole('button', { name: 'Duplicate stage' }))
  expect(screen.getAllByRole('listitem')).toHaveLength(3)
  fireEvent.click(within(stage(2)).getByRole('button', { name: 'Move up' }))
  fireEvent.click(within(stage(1)).getByRole('button', { name: 'Remove stage' }))
  expect(screen.getAllByRole('listitem')).toHaveLength(2)
  fireEvent.click(screen.getByRole('button', { name: 'Use this chain' }))
  const plan = used.at(-1)!
  const ids = new Set(plan.nodes.map((node) => node.id))
  for (const node of plan.nodes.filter(isWorkPlanWorkerNode)) {
    for (const read of node.readsFrom ?? []) {
      expect(ids.has(read)).toBe(true)
    }
  }
})
