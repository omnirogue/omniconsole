// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkflowCheck } from '../../../../shared/workflow-graph'
import type { WorkflowImproveFinal } from '../../../../shared/workflow-improve-trail'
import { WorkflowImproveCodeFields } from './WorkflowImproveCodeFields'
import { workflowImproveFinalText } from './WorkflowImproveFinalTest'
import { workflowKeepBackEveryThird } from './WorkflowImproveSealedFields'
import { WorkflowImproveTestFields, workflowImproveTestSummary } from './WorkflowImproveTestFields'
import { workflowWorkspaceIsFolder } from './WorkflowWorkspaceKind'
import { WorkflowWorkspaceIsFolder } from './workflow-workspace-kind-context'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, english: string, values?: Record<string, string | number>) =>
    english.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => String(values?.[key] ?? ''))
}))
vi.mock('@/store', () => ({ useAppStore: vi.fn() }))
vi.mock('./workflow-graph-controls', () => ({ WorkflowSelect: () => null }))
afterEach(cleanup)

function renderFields(check: WorkflowCheck) {
  const onChange = vi.fn<(next: WorkflowCheck | undefined) => void>()
  render(<WorkflowImproveTestFields check={check} onChange={onChange} />)
  return onChange
}

describe('the final test, kept back, in setup', () => {
  it('explains itself, and where to keep its files', () => {
    renderFields({ command: 'npm test' })
    expect(screen.getByText('Final test, kept back (optional)')).toBeInTheDocument()
    expect(
      screen.getByText(
        'Cases or a command the AIs never see. Run once at the end to check the winner really beats what you started with.'
      )
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        'Keep the final-test files outside the workspace if the AIs must not be able to read them.'
      )
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Keep back every third case' })).toBeDisabled()
  })

  it('keeps back every third practice case, the same split every time', () => {
    const check = { command: 'npm test {case}', cases: ['a', 'b', 'c', '', 'd', 'e', 'f', 'g'] }
    const onChange = renderFields(check)
    fireEvent.click(screen.getByRole('button', { name: 'Keep back every third case' }))
    expect(onChange).toHaveBeenLastCalledWith({
      command: 'npm test {case}',
      cases: ['a', 'b', 'd', 'e', 'g'],
      sealed: { cases: ['c', 'f'] }
    })
    expect(workflowKeepBackEveryThird(check)).toEqual(workflowKeepBackEveryThird(check))
    expect(
      workflowKeepBackEveryThird({ command: 'x', cases: ['a', 'b', 'c'], sealed: { cases: ['z'] } })
    ).toEqual({ cases: ['a', 'b'], sealed: { cases: ['z', 'c'] } })
  })

  it('takes its own command and cases as typed, and drops them when cleared', () => {
    const onChange = renderFields({ command: 'npm test', sealed: { cases: ['x'] } })
    fireEvent.change(screen.getByLabelText('Final test command'), {
      target: { value: 'npm run final' }
    })
    expect(onChange).toHaveBeenLastCalledWith({
      command: 'npm test',
      sealed: { cases: ['x'], command: 'npm run final' }
    })
    fireEvent.change(screen.getByLabelText('Kept-back cases, one per line'), {
      target: { value: '\n' }
    })
    expect(onChange).toHaveBeenLastCalledWith({ command: 'npm test' })
  })

  it('sums it up in the options line', () => {
    expect(
      workflowImproveTestSummary({ command: 'x', sealed: { cases: ['a', ' ', 'b'] } })
    ).toEqual(['checked', 'kept back: 2'])
    expect(workflowImproveTestSummary({ command: 'x', sealed: { command: 'y' } })).toEqual([
      'checked',
      'final test kept back'
    ])
  })
})

describe('a folder workspace cannot test a change to the code', () => {
  it('disables the choice and says why', () => {
    render(
      <WorkflowWorkspaceIsFolder.Provider value={true}>
        <WorkflowImproveCodeFields check={{ command: 'npm test' }} onChange={() => {}} />
      </WorkflowWorkspaceIsFolder.Provider>
    )
    expect(screen.getByRole('radio', { name: 'A change to this code' })).toBeDisabled()
    expect(
      screen.getByText(
        'A change to this code needs a Git repository, and this workspace is a plain folder.'
      )
    ).toBeInTheDocument()
  })

  it('keeps the choice for a Git repository', () => {
    render(<WorkflowImproveCodeFields check={{ command: 'npm test' }} onChange={() => {}} />)
    expect(screen.getByRole('radio', { name: 'A change to this code' })).toBeEnabled()
  })

  it('reads the kind from a folder workspace, or a repository added as a folder', () => {
    const repos = [
      { id: 'plain', kind: 'folder' as const },
      { id: 'repo', kind: 'git' as const }
    ]
    expect(workflowWorkspaceIsFolder(repos, 'folder:abc')).toBe(true)
    expect(workflowWorkspaceIsFolder(repos, 'plain::/Users/me/plain')).toBe(true)
    expect(workflowWorkspaceIsFolder(repos, 'repo::/Users/me/repo')).toBe(false)
    expect(workflowWorkspaceIsFolder(repos, 'unknown::/x')).toBe(false)
  })
})

describe('the final test in the trail', () => {
  const final = (change: Partial<WorkflowImproveFinal>): WorkflowImproveFinal => ({
    cases: 4,
    start: 'unchanged',
    verdict: 'held',
    best: { passed: 4 },
    started: { passed: 2 },
    ...change
  })

  it("says each result in the person's words", () => {
    expect(workflowImproveFinalText(final({}))).toBe(
      'Final test (4 cases kept back): the new version passed 4, what you started with passed 2. The improvement held.'
    )
    expect(
      workflowImproveFinalText(
        final({ verdict: 'tied', best: { passed: 3 }, started: { passed: 3 } })
      )
    ).toBe(
      'Final test (4 cases kept back): both passed 3. It did no better on cases it never saw, so the gain may not carry over.'
    )
    expect(
      workflowImproveFinalText(
        final({ verdict: 'worse', best: { passed: 2 }, started: { passed: 3 } })
      )
    ).toBe(
      'Final test (4 cases kept back): the new version passed 2, what you started with passed 3. Keep what you have.'
    )
    expect(workflowImproveFinalText(final({ start: 'round-1', verdict: undefined }))).toBe(
      'Final test (4 cases kept back): running…'
    )
  })

  it('never shows a final test that could not run as held', () => {
    const text = workflowImproveFinalText(final({ verdict: 'unavailable' }))
    expect(text).toBe(
      'Final test (4 cases kept back): it could not run in full, so whether the improvement holds is unknown.'
    )
    expect(text).not.toMatch(/held/)
  })
})
