// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkflowCheck } from '../../../../shared/workflow-graph'
import type { WorkflowImproveCandidate } from '../../../../shared/workflow-improve-trail'
import {
  WorkflowImprovePredictionNotes,
  workflowPredictionText
} from './WorkflowImprovePredictionNotes'
import { WorkflowImproveTestFields } from './WorkflowImproveTestFields'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, english: string, values?: Record<string, string | number>) =>
    english.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => String(values?.[key] ?? ''))
}))
vi.mock('./workflow-graph-controls', () => ({ WorkflowSelect: () => null }))
afterEach(cleanup)

describe('workflowPredictionText', () => {
  it('says whether each version was kept or killed, in plain words', () => {
    expect(
      workflowPredictionText({
        verdict: 'held',
        predicted: { op: '>=', score: 80 },
        measured: { passed: true, score: 84 }
      })
    ).toBe('Kept: prediction held (predicted SCORE ≥ 80, measured 84).')
    expect(
      workflowPredictionText({
        verdict: 'missed',
        predicted: { outcome: 'pass' },
        measured: { passed: false }
      })
    ).toBe('Killed: predicted PASS, it failed.')
    expect(
      workflowPredictionText({
        verdict: 'missed',
        predicted: { op: '<', score: 3 },
        measured: { passed: true }
      })
    ).toBe('Killed: predicted SCORE < 3, it printed no score.')
    expect(workflowPredictionText({ verdict: 'missing' })).toBe('Killed: it gave no prediction.')
    expect(workflowPredictionText({ verdict: 'untested', predicted: { outcome: 'fail' } })).toBe(
      'Kept: the test could not run, so its prediction (FAIL) was not tested.'
    )
  })

  it('lists only the versions that were asked to predict, by name', () => {
    const candidates: WorkflowImproveCandidate[] = [
      {
        label: 'A',
        name: 'Claude',
        seatId: 'a',
        role: 'improve',
        prediction: { verdict: 'missing' }
      },
      { label: 'B', name: 'Codex', seatId: 'b', role: 'best' }
    ]
    render(<WorkflowImprovePredictionNotes candidates={candidates} name={(entry) => entry.name} />)
    expect(screen.getByText('Claude: Killed: it gave no prediction.')).toBeInTheDocument()
    expect(screen.queryByText(/Codex/)).toBeNull()
  })
})

describe('the predictions toggle', () => {
  it('is set only by the person, and saves nothing when off', () => {
    const onChange = vi.fn<(next: WorkflowCheck | undefined) => void>()
    const { rerender } = render(
      <WorkflowImproveTestFields check={{ command: 'npm test' }} onChange={onChange} />
    )
    const toggle = screen.getByRole('checkbox', {
      name: 'Each version is a hypothesis: it must predict the result first'
    })
    fireEvent.click(toggle)
    expect(onChange).toHaveBeenLastCalledWith({ command: 'npm test', predict: true })
    rerender(
      <WorkflowImproveTestFields
        check={{ command: 'npm test', predict: true }}
        onChange={onChange}
      />
    )
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: 'Each version is a hypothesis: it must predict the result first'
      })
    )
    expect(onChange).toHaveBeenLastCalledWith({ command: 'npm test' })
  })
})
