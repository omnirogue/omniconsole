// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { workflowTemplate } from '../../../../shared/workflow-graph-templates'
import type { WorkflowSpec } from '../../../../shared/workflow-graph'
import type { WorkflowLoopView } from '../../../../shared/workflow-improve-trail'
import { WorkflowImprovePopulationField } from './WorkflowImprovePopulationField'
import { WorkflowImproveTrail } from './WorkflowImproveTrail'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, english: string, values?: Record<string, string | number>) =>
    english.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => String(values?.[key] ?? ''))
}))
vi.mock('@/components/ModelDot', () => ({ ModelDot: () => null }))
vi.mock('./workflow-graph-controls', () => ({
  WorkflowSelect: ({
    value,
    options,
    onChange
  }: {
    value: string
    options: { value: string; label: string }[]
    onChange: (value: string) => void
  }) => (
    <select value={value} onChange={(event) => onChange(event.target.value)}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  )
}))
afterEach(cleanup)

const ROUTES = ['claude', 'codex', 'grok'] as const

function renderField(spec: WorkflowSpec) {
  const onChange = vi.fn<(next: WorkflowSpec) => void>()
  render(<WorkflowImprovePopulationField spec={spec} available={ROUTES} onChange={onChange} />)
  return onChange
}

describe('WorkflowImprovePopulationField', () => {
  it('sets how many versions to build on, saving nothing for only the best', () => {
    const spec = workflowTemplate('improve', ROUTES)
    const onChange = renderField(spec)
    const select = screen.getByDisplayValue('Only the best version')
    fireEvent.change(select, { target: { value: '3' } })
    expect(onChange.mock.calls[0]![0].repeat?.population).toBe(3)
    cleanup()
    const again = renderField({ ...spec, repeat: { ...spec.repeat!, population: 3 } })
    expect(
      screen.getByDisplayValue('The best and up to 2 others that pass different cases')
    ).toBeInTheDocument()
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '1' } })
    expect(again.mock.calls[0]![0].repeat).not.toHaveProperty('population')
  })

  it('nudges to four a round only with a test, and sets both numbers', () => {
    const spec = workflowTemplate('improve', ROUTES)
    renderField(spec)
    expect(screen.queryByRole('button', { name: /recommended with tests/ })).toBeNull()
    cleanup()
    const onChange = renderField({ ...spec, repeat: { ...spec.repeat!, check: { command: 't' } } })
    fireEvent.click(screen.getByRole('button', { name: 'Use 4 a round (recommended with tests)' }))
    const next = onChange.mock.calls[0]![0]
    expect(next.repeat?.population).toBe(4)
    expect(next.steps.find((step) => step.id === 'improve')?.agents).toHaveLength(4)
  })
})

describe('WorkflowImproveTrail: parents', () => {
  it('says which version each new version built on', () => {
    const loop: WorkflowLoopView = {
      round: 2,
      maxRounds: 6,
      status: 'running',
      improve: {
        stale: 0,
        patience: 2,
        rounds: [
          {
            round: 2,
            mode: 'improve',
            judgedBy: ['check'],
            result: 'pending',
            candidates: [
              {
                label: 'A',
                name: 'Claude',
                seatId: 'a',
                role: 'improve',
                parent: { round: 1, name: 'Codex' }
              },
              {
                label: 'B',
                name: 'Grok',
                seatId: 'b',
                role: 'first',
                parent: { round: 0, name: 'No change' }
              }
            ]
          }
        ]
      }
    }
    render(<WorkflowImproveTrail loop={loop} seats={[]} />)
    expect(screen.getByText('builds on Codex, round 1')).toBeInTheDocument()
    expect(screen.getByText('builds on your code as it is')).toBeInTheDocument()
  })
})
