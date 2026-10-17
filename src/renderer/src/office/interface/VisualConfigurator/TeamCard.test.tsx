// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import type { AgenticSystem } from '../../data/agents'
import { DEFAULT_AGENTIC_SET_ID } from '../../data/agents'
import { TeamCard } from './TeamCard'

const mocks = vi.hoisted(() => ({
  updateSystem: vi.fn(),
  deleteCustomSystem: vi.fn(),
  setActiveTeam: vi.fn(),
  resetScene: vi.fn()
}))

vi.mock('../../integration/store/teamStore', () => ({
  useTeamStore: (selector: (state: typeof mocks & { selectedAgentSetId: string }) => unknown) =>
    selector({ ...mocks, selectedAgentSetId: 'team-a' })
}))
vi.mock('../../simulation/SceneContext', () => ({
  useSceneManager: () => ({ resetScene: mocks.resetScene })
}))
vi.mock('./ColorPicker', () => ({
  ColorPicker: ({ onChange }: { onChange: (color: string) => void }) => (
    <button onClick={() => onChange('#ffffff')}>Use light color</button>
  )
}))
vi.mock('./TeamOutputConfig', () => ({ TeamOutputConfig: () => null }))
vi.mock('../components/TeamOutputBadge', () => ({ TeamOutputBadge: () => null }))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(values?.[name] ?? ''))
}))

function makeSystem(overrides: Partial<AgenticSystem> = {}): AgenticSystem {
  return {
    id: 'team-a',
    teamName: 'Support',
    teamType: 'Customer service',
    teamDescription: 'Reply to customers.',
    color: '#334455',
    outputType: 'text',
    outputModel: 'gemini-3-flash-preview',
    outputAutoApprove: true,
    user: { index: 0, model: 'Operator' },
    leadAgent: {
      id: 'lead-a',
      index: 1,
      name: 'Coordinator',
      description: 'Coordinate replies.',
      color: '#334455',
      model: 'gemini-3-flash-preview'
    },
    ...overrides
  }
}

function makeProps(overrides: Partial<ComponentProps<typeof TeamCard>> = {}) {
  return {
    system: makeSystem(),
    isSelected: true,
    isActive: false,
    isPredefined: false,
    mode: 'edit' as const,
    onSelectTeam: vi.fn(),
    onModeChange: vi.fn(),
    ...overrides
  }
}

function changeName(value: string): void {
  fireEvent.change(screen.getAllByRole('textbox')[0], { target: { value } })
}

function closeEditor(): void {
  fireEvent.click(screen.getByRole('button', { name: '' }))
}

function expectDraft(name: string, type: string, description: string): void {
  expect(screen.getAllByRole('textbox').map((field) => (field as HTMLInputElement).value)).toEqual([
    name,
    type,
    description
  ])
}

beforeEach(() => vi.clearAllMocks())
afterEach(cleanup)

describe('TeamCard editing', () => {
  it('renders the saved draft fields on the first render', () => {
    const markup = renderToStaticMarkup(<TeamCard {...makeProps()} />)
    const markupDocument = new DOMParser().parseFromString(markup, 'text/html')
    expect(
      Array.from(
        markupDocument.querySelectorAll('input, textarea'),
        (field) => (field as HTMLInputElement).value
      )
    ).toEqual(['Support', 'Customer service', 'Reply to customers.'])
  })

  it('opens edit mode with saved values and clears invalid drafts on reentry', () => {
    const props = makeProps()
    const { rerender } = render(<TeamCard {...props} mode="view" />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit Team' }))
    expect(props.onModeChange).toHaveBeenCalledWith('edit')
    rerender(<TeamCard {...props} />)
    expectDraft('Support', 'Customer service', 'Reply to customers.')
    changeName('')
    closeEditor()
    expect(screen.queryByText(/Please fill Name/)).not.toBeNull()
    rerender(<TeamCard {...props} mode="view" />)
    rerender(<TeamCard {...props} />)
    expectDraft('Support', 'Customer service', 'Reply to customers.')
    expect(screen.queryByText(/Please fill Name/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
  })

  it('preserves the local draft across an unrelated parent rerender', () => {
    const props = makeProps()
    const { rerender } = render(<TeamCard {...props} />)
    changeName('Local draft')
    rerender(<TeamCard {...props} isActive system={{ ...props.system }} />)
    expectDraft('Local draft', 'Customer service', 'Reply to customers.')
  })

  it('refreshes a changed incoming system with the same ID and clears stale errors', () => {
    const props = makeProps()
    const { rerender } = render(<TeamCard {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Use light color' }))
    closeEditor()
    expect(screen.queryByText(/Please choose a darker color/)).not.toBeNull()
    expect(
      (screen.getByRole('button', { name: 'Save Changes' }) as HTMLButtonElement).disabled
    ).toBe(true)
    rerender(
      <TeamCard
        {...props}
        system={makeSystem({
          teamName: 'Updated support',
          teamType: 'Operations',
          teamDescription: 'Follow up.'
        })}
      />
    )
    expectDraft('Updated support', 'Operations', 'Follow up.')
    expect(screen.queryByText(/Please choose a darker color/)).toBeNull()
    expect(
      (screen.getByRole('button', { name: 'Save Changes' }) as HTMLButtonElement).disabled
    ).toBe(false)
  })

  it('resets draft and delete confirmation when a different team is selected', () => {
    const props = makeProps()
    const { rerender } = render(<TeamCard {...props} />)
    changeName('Discard me')
    fireEvent.click(screen.getByRole('button', { name: 'Delete Team' }))
    expect(screen.queryByText('Delete this team?')).not.toBeNull()
    rerender(<TeamCard {...props} system={makeSystem({ id: 'team-b', teamName: 'Content' })} />)
    expectDraft('Content', 'Customer service', 'Reply to customers.')
    expect(screen.queryByText('Delete this team?')).toBeNull()
    expect(screen.queryByRole('button', { name: 'OK' })).toBeNull()
  })

  it('clears a pending delete confirmation when editing is left and reentered', () => {
    const props = makeProps()
    const { rerender } = render(<TeamCard {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete Team' }))
    rerender(<TeamCard {...props} isSelected={false} />)
    rerender(<TeamCard {...props} />)
    expect(screen.queryByText('Delete this team?')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
    expect(mocks.deleteCustomSystem).not.toHaveBeenCalled()
  })

  it('saves the current draft and returns to view mode', () => {
    const props = makeProps()
    render(<TeamCard {...props} />)
    changeName('Customer care')
    fireEvent.change(screen.getAllByRole('textbox')[2], { target: { value: 'Resolve requests.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }))
    expect(mocks.updateSystem).toHaveBeenCalledExactlyOnceWith(
      'team-a',
      expect.objectContaining({
        teamName: 'Customer care',
        teamType: 'Customer service',
        teamDescription: 'Resolve requests.',
        outputType: 'text',
        outputModel: 'gemini-3-flash-preview',
        outputAutoApprove: true
      })
    )
    expect(props.onModeChange).toHaveBeenCalledExactlyOnceWith('view')
  })

  it('requires a second close to discard unsaved changes and restores saved values next time', () => {
    const props = makeProps()
    const { rerender } = render(<TeamCard {...props} />)
    changeName('Unsaved name')
    closeEditor()
    expect(screen.queryByText(/Unsaved changes will be lost/)).not.toBeNull()
    expect(props.onModeChange).not.toHaveBeenCalled()
    closeEditor()
    expect(props.onModeChange).toHaveBeenCalledExactlyOnceWith('view')
    expect(mocks.updateSystem).not.toHaveBeenCalled()
    rerender(<TeamCard {...props} mode="view" />)
    rerender(<TeamCard {...props} />)
    expectDraft('Support', 'Customer service', 'Reply to customers.')
    expect(screen.queryByText(/Unsaved changes will be lost/)).toBeNull()
  })

  it('cancels deletion without losing the draft, and deletes only after confirmation', () => {
    const props = makeProps()
    render(<TeamCard {...props} />)
    changeName('Keep my draft')
    fireEvent.click(screen.getByRole('button', { name: 'Delete Team' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByText('Delete this team?')).toBeNull()
    expectDraft('Keep my draft', 'Customer service', 'Reply to customers.')
    expect(mocks.deleteCustomSystem).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Delete Team' }))
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    expect(mocks.deleteCustomSystem).toHaveBeenCalledExactlyOnceWith('team-a')
    expect(mocks.setActiveTeam).toHaveBeenCalledExactlyOnceWith(DEFAULT_AGENTIC_SET_ID)
    expect(mocks.resetScene).toHaveBeenCalledOnce()
    expect(props.onModeChange).toHaveBeenCalledExactlyOnceWith('view')
  })
})
