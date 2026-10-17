// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LocalWorkflowView } from '../../../../shared/local-workflow-view'
import { normalizeWorkflowSpec } from '../../../../shared/workflow-graph-normalize'
import { WorkflowRunHeader } from './WorkflowRunHeader'
import { discoverRunView } from './local-workflow-run.fixtures'
import {
  WorkflowMaxAgentsField,
  workflowMaxAgentsForStart
} from '../workflow-graph/WorkflowMaxAgentsField'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, english: string, values?: Record<string, string | number>) =>
    english.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => String(values?.[key] ?? ''))
}))
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function running(extra: Partial<LocalWorkflowView>): LocalWorkflowView {
  return {
    ...discoverRunView(),
    state: 'running',
    finishedAt: undefined,
    running: 2,
    actions: ['pause', 'stop'],
    ...extra
  }
}

const spec = normalizeWorkflowSpec({
  title: 'Research',
  steps: [
    { id: 'research', kind: 'do', title: 'Research', agents: [{}, {}, {}] },
    { id: 'critics', kind: 'review', title: 'Critics', agents: [{}, {}], inputs: ['research'] },
    { id: 'final', kind: 'synthesize', title: 'Final', inputs: ['research', 'critics'] }
  ]
})

describe('Finish now in the run header', () => {
  it('offers Finish now only when the host says it can, and sends finish', () => {
    const onAction = vi.fn()
    const { rerender } = render(
      <WorkflowRunHeader view={running({})} pending={false} onAction={onAction} />
    )
    expect(screen.queryByRole('button', { name: 'Finish now' })).toBeNull()
    rerender(
      <WorkflowRunHeader view={running({ canFinish: true })} pending={false} onAction={onAction} />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Finish now' }))
    expect(onAction).toHaveBeenCalledWith('finish')
    expect(screen.getByRole('button', { name: 'Pause' })).toBeVisible()
  })

  it('says the run is finishing while it wraps up', () => {
    render(<WorkflowRunHeader view={running({ finishing: true })} pending={false} />)
    expect(screen.getByText(/Finishing · no new agents/)).toBeVisible()
  })
})

describe('Max agents', () => {
  it('shows the bound as a placeholder and reports what the person types', () => {
    const onChange = vi.fn()
    const { rerender } = render(
      <WorkflowMaxAgentsField spec={spec} planned={6} onChange={onChange} />
    )
    const field = screen.getByRole('spinbutton')
    expect(field).toHaveAttribute('placeholder', '6')
    fireEvent.change(field, { target: { value: '4' } })
    expect(onChange).toHaveBeenLastCalledWith(4)
    rerender(<WorkflowMaxAgentsField spec={spec} planned={6} value={4} onChange={onChange} />)
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '' } })
    expect(onChange).toHaveBeenLastCalledWith(undefined)
  })

  it('sends a cap only below the bound, never below room for the report', () => {
    expect(workflowMaxAgentsForStart(spec, 6)).toBeUndefined()
    expect(workflowMaxAgentsForStart(spec, 6, 6)).toBeUndefined()
    expect(workflowMaxAgentsForStart(spec, 6, 4)).toBe(4)
    expect(workflowMaxAgentsForStart(spec, 6, 1)).toBe(2)
  })

  it('is absent for a workflow that cannot finish early', () => {
    const looped = normalizeWorkflowSpec({
      title: 'Improve',
      steps: [
        { id: 'draft', kind: 'do', title: 'Draft', agents: [{}] },
        { id: 'rank', kind: 'rank', title: 'Rank', agents: [{}, {}], inputs: ['draft'] }
      ],
      repeat: { do: 'draft', review: 'rank', until: 'plateau', maxRounds: 3 }
    })
    render(<WorkflowMaxAgentsField spec={looped} planned={9} onChange={() => {}} />)
    expect(screen.queryByRole('spinbutton')).toBeNull()
  })
})
