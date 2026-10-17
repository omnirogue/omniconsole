// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import type { ReactNode } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NewWorkflowMenu } from './NewWorkflowMenu'
import { OTHER_WORKFLOW_MENU_ORDER, PRIMARY_WORKFLOW_MENU_ORDER } from './workflow-presets'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, english: string) => english
}))
// Every submenu rendered open, so the test reads the whole picker.
vi.mock('@/components/ui/dropdown-menu', () => {
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>
  return {
    DropdownMenuSub: Pass,
    DropdownMenuSubTrigger: Pass,
    DropdownMenuSubContent: Pass,
    DropdownMenuLabel: Pass,
    DropdownMenuItem: ({ children, onSelect }: { children?: ReactNode; onSelect?: () => void }) => (
      <button type="button" onClick={onSelect}>
        {children}
      </button>
    )
  }
})
afterEach(cleanup)

describe('NewWorkflowMenu', () => {
  it('offers the workflows, and no JEV trials', () => {
    render(
      <NewWorkflowMenu hover={{} as never} onWorkflow={vi.fn()}>
        <span>models</span>
      </NewWorkflowMenu>
    )
    expect(screen.getByText('Multi-agent workflows')).toBeInTheDocument()
    expect(screen.queryByText(/JEV trials/i)).toBeNull()
    for (const title of ['JEV Ad Check', 'JEV Evidence Check', 'JEV Work Triage']) {
      expect(screen.queryByText(title)).toBeNull()
    }
  })

  it('offers complete versions through Find the best, not a separate Best of N', () => {
    render(
      <NewWorkflowMenu hover={{} as never} onWorkflow={vi.fn()}>
        <span>models</span>
      </NewWorkflowMenu>
    )
    expect(screen.getByText('Find the best')).toBeInTheDocument()
    expect(screen.getByText(/a few complete versions/)).toBeInTheDocument()
    expect(screen.queryByText('Best of N')).toBeNull()
  })

  it('offers Audit and the other workflows, while Decide replaces Council', () => {
    render(
      <NewWorkflowMenu hover={{} as never} onWorkflow={vi.fn()}>
        <span>models</span>
      </NewWorkflowMenu>
    )
    for (const title of [
      'Discover',
      'Audit',
      'Investigate',
      'Decide',
      'Find the best',
      'Improve',
      'Evolve'
    ]) {
      expect(screen.getByText(title)).toBeInTheDocument()
    }
    expect(screen.getByText('Build + Review')).toBeInTheDocument()
    expect(screen.queryByText('Council')).toBeNull()
  })

  it('opens Audit through the ordinary workflow entry', () => {
    const open = vi.fn()
    render(
      <NewWorkflowMenu hover={{} as never} onWorkflow={open}>
        <span>models</span>
      </NewWorkflowMenu>
    )
    fireEvent.click(screen.getByRole('button', { name: /^Audit/ }))
    expect(open).toHaveBeenCalledWith('audit')
  })

  it('keeps Discover and Evolve as the primary workflows and collapses the rest under Other', () => {
    expect(PRIMARY_WORKFLOW_MENU_ORDER).toEqual(['discover', 'evolve'])
    expect(OTHER_WORKFLOW_MENU_ORDER).toEqual([
      'improve',
      'find',
      'decide',
      'investigate',
      'audit',
      'build-review'
    ])
    render(
      <NewWorkflowMenu hover={{} as never} onWorkflow={vi.fn()}>
        <span>models</span>
      </NewWorkflowMenu>
    )
    expect(screen.getByText('Other')).toBeInTheDocument()
    expect(
      screen.getByText('Improve, Find the best, Decide, Investigate, Audit, Build + Review')
    ).toBeInTheDocument()
  })
})
