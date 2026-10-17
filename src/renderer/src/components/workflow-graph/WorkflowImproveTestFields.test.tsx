// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkflowCheck } from '../../../../shared/workflow-graph'
import type { WorkflowLoopView } from '../../../../shared/workflow-improve-trail'
import { WorkflowImproveTestFields, workflowImproveTestSummary } from './WorkflowImproveTestFields'
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
    <select
      aria-label="Time limit"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  )
}))
afterEach(cleanup)

function renderFields(check: WorkflowCheck | undefined) {
  const onChange = vi.fn<(next: WorkflowCheck | undefined) => void>()
  render(<WorkflowImproveTestFields check={check} onChange={onChange} />)
  return onChange
}

describe('WorkflowImproveTestFields', () => {
  it('asks how to test each version, and offers cases only once there is a command', () => {
    const onChange = renderFields(undefined)
    const command = screen.getByLabelText(/How to test each version \(optional\)/)
    expect(command).toHaveAttribute('placeholder', 'e.g. pnpm test')
    expect(
      screen.getByText(/Tests run on this computer, as you, and may run code the AIs wrote\./)
    ).toBeInTheDocument()
    expect(screen.queryByText('Practice cases (optional, one per line)')).toBeNull()
    fireEvent.change(command, { target: { value: 'node t.mjs {case}' } })
    expect(onChange).toHaveBeenLastCalledWith({ command: 'node t.mjs {case}' })
  })

  it('keeps practice cases as typed, one per line, and drops them when emptied', () => {
    const onChange = renderFields({ command: 'node t.mjs {case}', stopWhenPassing: true })
    expect(
      screen.getByText(
        'Each version is tested on every line. The line replaces {case} in the command.'
      )
    ).toBeInTheDocument()
    const cases = screen.getByLabelText(/Practice cases \(optional, one per line\)/)
    fireEvent.change(cases, { target: { value: 'a\n\nb' } })
    expect(onChange).toHaveBeenLastCalledWith({
      command: 'node t.mjs {case}',
      stopWhenPassing: true,
      cases: ['a', '', 'b']
    })
    fireEvent.change(cases, { target: { value: '\n' } })
    expect(onChange).toHaveBeenLastCalledWith({
      command: 'node t.mjs {case}',
      stopWhenPassing: true
    })
  })

  it('sets a time limit per test, and leaves the default unsaved', () => {
    const onChange = renderFields({ command: 'npm test', timeoutSeconds: 30 })
    expect(screen.getByText('Time limit per test')).toBeInTheDocument()
    const limit = screen.getByLabelText('Time limit') as HTMLSelectElement
    expect(limit.value).toBe('30')
    expect([...limit.options].map((option) => option.text)).toEqual([
      '30 s',
      '1 min',
      '3 min',
      '5 min',
      '10 min',
      '30 min'
    ])
    fireEvent.change(limit, { target: { value: '180' } })
    expect(onChange).toHaveBeenLastCalledWith({ command: 'npm test' })
    fireEvent.change(limit, { target: { value: '600' } })
    expect(onChange).toHaveBeenLastCalledWith({ command: 'npm test', timeoutSeconds: 600 })
  })

  it('removes the whole test when the command is cleared', () => {
    const onChange = renderFields({ command: 'npm test', cases: ['a'] })
    fireEvent.change(screen.getByLabelText(/How to test each version/), { target: { value: ' ' } })
    expect(onChange).toHaveBeenLastCalledWith(undefined)
  })

  it('sums the test up in the options line', () => {
    expect(workflowImproveTestSummary(undefined)).toEqual([])
    expect(workflowImproveTestSummary({ command: 'x', cases: ['a', ' ', 'b'] })).toEqual([
      'checked',
      'practice cases: 2'
    ])
  })
})

describe('the Improve trail under rules 2', () => {
  const loop = (stop: 'passing-kept' | 'plateau'): WorkflowLoopView => ({
    round: 3,
    maxRounds: 6,
    status: stop === 'plateau' ? 'plateau' : 'verified',
    improve: {
      rounds: [
        {
          round: 2,
          mode: 'improve',
          judgedBy: ['check', 'jev'],
          result: 'new-best',
          noGain: true,
          candidates: [
            {
              label: 'Response A',
              name: 'Claude',
              seatId: 's',
              role: 'best',
              check: { passed: true, cases: { passed: 2, total: 2 } }
            }
          ]
        }
      ],
      stale: 2,
      patience: 2,
      measured: true,
      stop
    }
  })

  it('says when every practice case passes and the judges kept the best version', () => {
    render(<WorkflowImproveTrail loop={loop('passing-kept')} seats={[]} />)
    expect(
      screen.getByText(
        'Stopped: every practice case passes, and the judges preferred the best version to each new change'
      )
    ).toBeInTheDocument()
    expect(screen.getByText('2/2 cases')).toBeInTheDocument()
    expect(screen.getByText('new best · no better test result')).toBeInTheDocument()
  })

  it('names a measured plateau as no better test result', () => {
    render(<WorkflowImproveTrail loop={loop('plateau')} seats={[]} />)
    expect(
      screen.getByText('Stopped: 2 rounds in a row brought no better test result')
    ).toBeInTheDocument()
  })
})
