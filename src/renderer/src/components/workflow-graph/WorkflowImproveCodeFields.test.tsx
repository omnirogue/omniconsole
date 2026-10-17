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
vi.mock('./workflow-graph-controls', () => ({ WorkflowSelect: () => null }))
afterEach(cleanup)

const WARNING =
  'Tests run on this computer, as you, and may run code the AIs wrote. A change to your code is tested in a private copy, never in your files.'

function renderFields(check: WorkflowCheck | undefined) {
  const onChange = vi.fn<(next: WorkflowCheck | undefined) => void>()
  render(<WorkflowImproveTestFields check={check} onChange={onChange} />)
  return onChange
}

describe('what each version is', () => {
  it('always shows the honest warning, and never calls the test a sandbox', () => {
    renderFields(undefined)
    expect(screen.getByText(WARNING)).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/sandbox/i)
    expect(screen.queryByText('What is each version?')).toBeNull()
  })

  it('offers text or a change to this code once there is a test, text first', () => {
    const onChange = renderFields({ command: 'npm test' })
    const text = screen.getByRole('radio', { name: 'Text (a draft, a prompt, a function)' })
    const code = screen.getByRole('radio', { name: 'A change to this code' })
    expect(screen.getByText('What is each version?')).toBeInTheDocument()
    expect(text).toHaveAttribute('aria-checked', 'true')
    expect(code).toHaveAttribute('aria-checked', 'false')
    expect(screen.queryByText('Get ready first (optional)')).toBeNull()
    expect(screen.queryByText('Files the AI may not change')).toBeNull()
    fireEvent.click(code)
    expect(onChange).toHaveBeenLastCalledWith({ command: 'npm test', apply: 'patch' })
  })

  it('asks what to get ready and which files the AI may not change, as the person types them', () => {
    const onChange = renderFields({ command: 'npm test', apply: 'patch' })
    expect(
      screen.getByText(
        'Each version is a diff, tested in a private copy of your last commit. Needs a Git repository with nothing uncommitted.'
      )
    ).toBeInTheDocument()
    expect(screen.getByText(/Runs in a private copy of this repository/)).toBeInTheDocument()
    expect(screen.queryByText(/Runs in this workspace on every version/)).toBeNull()
    const prepare = screen.getByLabelText(/Get ready first \(optional\)/)
    expect(prepare).toHaveAttribute('placeholder', 'e.g. pnpm install')
    fireEvent.change(prepare, { target: { value: 'pnpm install' } })
    expect(onChange).toHaveBeenLastCalledWith({
      command: 'npm test',
      apply: 'patch',
      prepare: 'pnpm install'
    })
    const protect = screen.getByLabelText(/Files the AI may not change/)
    expect(protect).toHaveAttribute('placeholder', 'e.g. tests/**')
    fireEvent.change(protect, { target: { value: 'tests/**\n\npackage.json' } })
    expect(onChange).toHaveBeenLastCalledWith({
      command: 'npm test',
      apply: 'patch',
      protect: ['tests/**', '', 'package.json']
    })
    expect(
      screen.getByText(
        'One pattern per line, as in .gitignore. A change that touches one of them fails its test.'
      )
    ).toBeInTheDocument()
  })

  it('drops the code settings when the person goes back to text', () => {
    const onChange = renderFields({
      command: 'npm test',
      apply: 'patch',
      prepare: 'pnpm install',
      protect: ['tests/**']
    })
    fireEvent.click(screen.getByRole('radio', { name: 'Text (a draft, a prompt, a function)' }))
    expect(onChange).toHaveBeenLastCalledWith({ command: 'npm test' })
  })

  it('sums a change to the code up in the options line', () => {
    expect(workflowImproveTestSummary({ command: 'x', apply: 'patch' })).toEqual([
      'checked',
      'changes to this code'
    ])
  })
})

describe('the Improve trail for changes to the code', () => {
  const loop: WorkflowLoopView = {
    round: 2,
    maxRounds: 6,
    status: 'plateau',
    improve: {
      rounds: [
        {
          round: 1,
          mode: 'first',
          judgedBy: ['check'],
          result: 'kept',
          candidates: [
            {
              label: 'Response A',
              name: 'Claude',
              seatId: 'claude',
              role: 'first',
              check: { passed: true, exits: ['process.exit'] }
            },
            {
              label: 'Response B',
              name: 'No change',
              seatId: 'unchanged',
              role: 'best',
              check: { passed: true }
            }
          ]
        }
      ],
      best: { round: 0, name: 'No change', seatId: 'unchanged' },
      stale: 1,
      patience: 1,
      measured: true,
      stop: 'plateau'
    }
  }

  it('says when nothing beat the code, and flags a change that exits early', () => {
    render(<WorkflowImproveTrail loop={loop} seats={[]} />)
    expect(
      screen.getByText('Nothing beat your code as it is, so it stays unchanged (the result below)')
    ).toBeInTheDocument()
    expect(screen.getByText('No change')).toBeInTheDocument()
    expect(screen.getByText('adds process.exit')).toBeInTheDocument()
    expect(screen.queryByText(/Best discovered/)).toBeNull()
  })
})
