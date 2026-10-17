// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkflowFind, WorkflowRoute } from '../../../../shared/workflow-graph'
import { workflowSetFind } from '../../../../shared/workflow-graph-find'
import { workflowTemplate } from '../../../../shared/workflow-graph-templates'
import { validateWorkflowSpec } from '../../../../shared/workflow-graph-validate'
import { WorkflowFindGitHubSearch } from './WorkflowFindGitHubSearch'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, english: string, values?: Record<string, string | number>) =>
    english.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => String(values?.[key] ?? ''))
}))
afterEach(cleanup)

const ROUTES: WorkflowRoute[] = ['claude', 'codex']

describe('Search GitHub', () => {
  it('takes a query and a count, and says plainly what the judges are given', () => {
    const onChange = vi.fn<(harvest: WorkflowFind['harvest'] | null) => void>()
    const { rerender } = render(
      <WorkflowFindGitHubSearch harvest={undefined} onChange={onChange} />
    )
    expect(screen.getByText('Search GitHub (optional)')).toBeInTheDocument()
    expect(
      screen.getByText(
        "Searches GitHub's public repositories. Only the name, stars, activity, language and licence are used: never the owner's description."
      )
    ).toBeInTheDocument()

    const query = screen.getByLabelText('Search GitHub (optional)')
    expect(query).toHaveAttribute('maxLength', '256')
    // Nothing to count until there is something to search for.
    expect(screen.getByLabelText('How many')).toBeDisabled()
    fireEvent.change(query, { target: { value: 'job queue language:go' } })
    expect(onChange).toHaveBeenCalledWith({ query: 'job queue language:go', max: 30 })

    rerender(
      <WorkflowFindGitHubSearch harvest={{ query: 'job queue', max: 30 }} onChange={onChange} />
    )
    const many = screen.getByLabelText('How many')
    expect(many).toHaveValue(30)
    expect(many).toHaveAttribute('min', '1')
    expect(many).toHaveAttribute('max', '100')
    fireEvent.change(many, { target: { value: '7' } })
    expect(onChange).toHaveBeenLastCalledWith({ query: 'job queue', max: 7 })
  })

  it('clears the search when the query is emptied', () => {
    const onChange = vi.fn<(harvest: WorkflowFind['harvest'] | null) => void>()
    render(<WorkflowFindGitHubSearch harvest={{ query: 'go', max: 30 }} onChange={onChange} />)
    fireEvent.change(screen.getByLabelText('Search GitHub (optional)'), { target: { value: '' } })
    expect(onChange).toHaveBeenCalledWith(null)
  })

  it('shows the person why a search they typed cannot run', () => {
    const problems = (harvest: WorkflowFind['harvest']) =>
      validateWorkflowSpec(workflowSetFind(workflowTemplate('find', ROUTES), { harvest }, ROUTES), {
        available: ROUTES
      }).problems.map((problem) => problem.message)
    expect(problems({ query: ' ', max: 30 })).toContain(
      'Type what to search GitHub for, for example "queue library language:go".'
    )
    expect(problems({ query: 'go', max: 500 })).toContain(
      'Search GitHub for between 1 and 100 repositories.'
    )
    expect(problems({ query: 'go', max: 30 })).toEqual([])
  })
})
