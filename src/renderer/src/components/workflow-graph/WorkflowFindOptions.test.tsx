// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkflowSpec } from '../../../../shared/workflow-graph'
import { workflowTemplate } from '../../../../shared/workflow-graph-templates'
import { WorkflowFindOptions } from './WorkflowFindOptions'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, english: string, values?: Record<string, string | number>) =>
    english.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => String(values?.[key] ?? ''))
}))
vi.mock('@/lib/agent-catalog', () => ({
  AgentIcon: ({ agent }: { agent: string }) => <span data-agent-icon={agent} />
}))
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

describe('WorkflowFindOptions', () => {
  it('comes up with 100 by default, takes a pasted list, and never leaves JEV out', () => {
    const spec = workflowTemplate('find', ROUTES)
    const onChange = vi.fn<(next: WorkflowSpec) => void>()
    const props = { available: ROUTES, onChange, onCustomize: vi.fn() }
    const { rerender } = render(<WorkflowFindOptions spec={spec} {...props} />)
    const toggle = screen.getByRole('button', { name: /Options/ })
    expect(toggle).toHaveTextContent('100 options · bring back 10 · 5 in the final · JEV judges')
    fireEvent.click(toggle)
    expect(screen.queryByRole('option', { name: 'Models only' })).toBeNull()
    // How many come back and how many meet in the final are separate choices.
    fireEvent.change(screen.getByLabelText('Bring back'), { target: { value: '50' } })
    expect(onChange.mock.calls.at(-1)![0].find).toMatchObject({ keep: 50, top: 5 })
    fireEvent.change(screen.getByLabelText('In the final'), { target: { value: '3' } })
    expect(onChange.mock.calls.at(-1)![0].find).toMatchObject({ keep: 10, top: 3 })
    fireEvent.change(screen.getByDisplayValue('The models come up with them'), {
      target: { value: 'list' }
    })
    const listed = onChange.mock.calls.at(-1)![0]
    expect(listed.find?.items).toEqual([])
    rerender(<WorkflowFindOptions spec={listed} {...props} />)
    fireEvent.change(screen.getByLabelText('Your options, one per line'), {
      target: { value: 'Crumb & Co\nThe Rising' }
    })
    expect(onChange.mock.calls.at(-1)![0].find?.items).toEqual(['Crumb & Co', 'The Rising'])
  })

  it('has each model write a complete version instead of listing options', () => {
    const onChange = vi.fn<(next: WorkflowSpec) => void>()
    const props = { available: ROUTES, onChange, onCustomize: vi.fn() }
    const { rerender } = render(
      <WorkflowFindOptions spec={workflowTemplate('find', ROUTES)} {...props} />
    )
    fireEvent.click(screen.getByRole('button', { name: /Options/ }))
    fireEvent.change(screen.getByDisplayValue('The models come up with them'), {
      target: { value: 'versions' }
    })
    const versions = onChange.mock.calls.at(-1)![0]
    expect(versions.find).toMatchObject({ versions: true, count: 4 })
    rerender(<WorkflowFindOptions spec={versions} {...props} />)
    expect(screen.getByRole('button', { name: /Options/ })).toHaveTextContent('4 complete versions')
    // Up to eight versions: one model call each.
    expect(
      [...screen.getByLabelText('How many').querySelectorAll('option')].map((o) => o.value)
    ).toEqual(['2', '3', '4', '5', '6', '7', '8'])
  })
})
