// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentBlock } from '../blocks/AgentBlock'
import { UpNextChips } from '../up-next-chips'
import { agentFixture, upNextFixture } from '../up-next-fixture'
import type { UpNextController } from '../use-up-next'
import { SavedWorkflowMenu, type SavedWorkflowSource } from './saved-workflow-menu'

vi.mock('./AgentModelFields', () => ({
  AgentModelFields: () => <div>Model and effort controls</div>
}))
vi.mock('./CustomStageDialog', () => ({ CustomStageDialog: () => <div>Custom dialog</div> }))
afterEach(cleanup)
const update = vi.fn(async () => true)
const controller = { update, disabled: false } as unknown as UpNextController

it('mounts no Advanced controls until disclosure opens and writes authoritative patches', async () => {
  const block = agentFixture('stage')
  const view = upNextFixture('chain')
  view.blocks.push(block)
  render(<AgentBlock block={block} view={view} controller={controller} />)
  expect(screen.queryByText('Model and effort controls')).toBeNull()
  expect(screen.queryByLabelText('Rounds')).toBeNull()
  expect(screen.queryByText('Stop when')).toBeNull()
  expect(screen.queryByText('Reads from')).toBeNull()
  expect(screen.queryByText('End this session when it completes successfully')).toBeNull()
  const details = screen.getByText('Advanced').parentElement as HTMLDetailsElement
  details.open = true
  fireEvent(details, new Event('toggle'))
  await waitFor(() => expect(screen.getByText('Model and effort controls')).toBeTruthy())
  expect(screen.getByText('Stop when')).toBeTruthy()
  expect(screen.getByText('Reads from')).toBeTruthy()
  fireEvent.change(screen.getByLabelText('Rounds'), { target: { value: '3' } })
  expect(update).toHaveBeenLastCalledWith('stage', { kind: 'agent', advanced: { rounds: 3 } })
  expect((screen.getByLabelText('Rounds') as HTMLInputElement).value).toBe('1')
  fireEvent.click(screen.getByLabelText('End this session when it completes successfully'))
  expect(update).toHaveBeenLastCalledWith('stage', {
    kind: 'agent',
    advanced: { endOnSuccess: true }
  })
})

it('shows chips only for non-default agent and receive values', () => {
  const block = agentFixture('stage')
  const { rerender, container } = render(<UpNextChips block={block} />)
  expect(container.textContent).toBe('')
  rerender(
    <UpNextChips
      block={{
        ...block,
        advanced: {
          model: 'opus',
          effort: 'high',
          rounds: 3,
          endOnSuccess: true,
          readsFrom: ['first'],
          stopWhen: 'zero_blockers'
        }
      }}
    />
  )
  for (const text of [
    'opus · high',
    '↻ up to 3×',
    'ends session on pass',
    'reads from first',
    'stop when zero blockers'
  ]) {
    expect(screen.getByText(text)).toBeTruthy()
  }
  const person = upNextFixture('review').blocks[0]!
  if (person.kind !== 'person') {
    throw new Error('Person fixture missing')
  }
  rerender(<UpNextChips block={person} />)
  expect(container.textContent).toBe('')
  rerender(
    <UpNextChips
      block={{ ...person, receive: { ...person.receive, transcript: true, createTaskCard: true } }}
    />
  )
  // Every send carries the full conversation, so the transcript is no option to mark.
  expect(screen.queryByText('+ transcript')).toBeNull()
  expect(screen.getByText('+ task card')).toBeTruthy()
})

it('renders an empty saved workflow shell and saves to its injected source', async () => {
  const source: SavedWorkflowSource = { list: () => [], save: vi.fn() }
  render(
    <SavedWorkflowMenu
      source={source}
      disabled={false}
      stage={{ kind: 'agent', template: 'improve' }}
      onUse={vi.fn()}
    />
  )
  expect(screen.getByRole('list', { name: 'Saved workflow' })).toBeTruthy()
  expect(await screen.findByText('No saved workflows yet.')).toBeTruthy()
  fireEvent.change(screen.getByLabelText('Save this stage as…'), {
    target: { value: 'Review stage' }
  })
  fireEvent.click(screen.getByText('Save stage'))
  expect(source.save).toHaveBeenCalledWith(
    expect.objectContaining({
      name: 'Review stage',
      executable: true,
      stage: { kind: 'agent', template: 'improve' }
    })
  )
})
