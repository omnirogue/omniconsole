// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { OutcomeLine } from './OutcomeLine'
import { nextActionChainFixture } from './next-action-fixture'
import { outcomeEditDefinitions, outcomeEditFrom, outcomeEditProblem } from './outcome-edit'
import type { OutcomeEditDoor } from './outcome-edit'

function fixture() {
  const chain = nextActionChainFixture(0)
  const outcome = chain.outcomeSet!.outcomes[0]!
  outcome.actions = [
    {
      id: 'audit',
      agent: 'codex',
      authority: 'existing-user-authority',
      conditionIds: ['receipt'],
      instruction: 'Audit the lifecycle.'
    }
  ]
  outcome.instructions = outcome.actions[0]!.instruction
  return chain
}

afterEach(cleanup)

it('edits the actual queued prompt through the revision checked user commit', async () => {
  const chain = fixture()
  const commit = vi.fn<OutcomeEditDoor['commit']>().mockResolvedValue(chain)
  render(
    <OutcomeLine
      chain={chain}
      onChainChanged={() => {}}
      door={{ commit, reload: async () => chain }}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'Edit next actions' }))
  fireEvent.change(screen.getByLabelText('Next action 1'), {
    target: { value: 'Audit watchers and background commands.' }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(commit).toHaveBeenCalledOnce())
  const request = commit.mock.calls[0]![0]
  expect(request.expectedRevision).toBe(chain.outcomeSet!.revision)
  expect(request.outcomes[0]).toMatchObject({
    id: 'outcome',
    dependsOn: [],
    instructions: 'Audit watchers and background commands.',
    actions: [
      { id: 'audit', agent: 'codex', instruction: 'Audit watchers and background commands.' }
    ]
  })
  expect(request.outcomes[0]!.conditions).toEqual(chain.outcomeSet!.outcomes[0]!.conditions)
})

it.each(['launching', 'running', 'unverifiable', 'completed'] as const)(
  'keeps %s actions read-only',
  (state) => {
    const chain = fixture()
    chain.outcomeSet!.attempts = [
      { id: 'attempt', outcomeId: 'outcome', actionId: 'audit', state } as never
    ]
    const edit = outcomeEditFrom(chain)
    expect(edit.actions[0]!.readOnly).toBe(true)
    edit.actions[0]!.instruction = 'Changed history'
    expect(outcomeEditDefinitions(chain, edit)[0]!.actions[0]!.instruction).toBe(
      'Audit the lifecycle.'
    )
  }
)

it('rejects an empty action without changing its identity or proof targets', () => {
  const edit = outcomeEditFrom(fixture())
  edit.actions[0]!.instruction = '  '
  expect(outcomeEditProblem(edit)).toBe('Enter a prompt for every next action.')
})
