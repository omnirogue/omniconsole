// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkflowDraft } from '@/lib/console-workflow-draft'
import { newWorkflowDraft, newWorkflowStage } from '@/lib/console-workflow-draft'
import LocalRunsPage from './LocalRunsPage'

const mocks = vi.hoisted(() => ({ admit: null as ((draft: WorkflowDraft) => void) | null }))

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, english: string) => english }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (value: string) => value }) }))
vi.mock('./LocalRunsSection', () => ({
  LocalRunsSection: ({ onAdmit }: { onAdmit: (draft: WorkflowDraft) => void }) => {
    mocks.admit = onAdmit
    return <div>Local runs section</div>
  }
}))
vi.mock('@/components/console-workflows/WorkflowComposer', () => ({
  WorkflowComposer: ({ initialDraft }: { initialDraft?: WorkflowDraft }) => (
    <div>{`Composer: ${initialDraft ? initialDraft.stages.map((s) => s.key).join(',') : 'empty'}`}</div>
  )
}))

beforeEach(() => {
  mocks.admit = null
})
afterEach(cleanup)

describe('the Local runs page', () => {
  it('hosts the section as its own door, with no composer until a graph is admitted', () => {
    render(<LocalRunsPage />)
    expect(screen.getByText('Local runs section')).toBeInTheDocument()
    expect(screen.queryByText(/Composer:/)).toBeNull()
  })

  it('hands an admitted graph to the console composer, which still owns approval', () => {
    render(<LocalRunsPage />)
    const draft = { ...newWorkflowDraft(''), title: 'Opener', stages: [newWorkflowStage('step-1')] }
    act(() => mocks.admit?.(draft))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText('Composer: step-1')).toBeInTheDocument()
  })
})
