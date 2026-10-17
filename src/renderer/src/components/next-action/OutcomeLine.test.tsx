// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { OutcomeLine } from './OutcomeLine'
import { nextActionChainFixture, nextActionChainlessFixture } from './next-action-fixture'
import { useDoneWhenListStore, openDoneWhenList } from './use-done-when-list'
import { clockLabel } from './up-next-labels'
import type { OutcomeEditDoor } from './outcome-edit'
type CommitRequest = Parameters<OutcomeEditDoor['commit']>[0]
import type { SessionChain } from '../../../../shared/session-chain-types'

afterEach(() => {
  cleanup()
  useDoneWhenListStore.setState({ openChainId: null })
})

function door(overrides: Partial<OutcomeEditDoor> = {}): OutcomeEditDoor {
  return {
    commit: vi.fn(async (args: { chain: SessionChain }) => args.chain),
    reload: vi.fn(async (chain: SessionChain) => chain),
    ...overrides
  } as OutcomeEditDoor
}

it('states the outcome and how much of it is proved, naming the open conditions', () => {
  render(<OutcomeLine chain={nextActionChainFixture()} onChainChanged={() => {}} door={door()} />)
  expect(document.querySelector('[data-next-action-outcome-sentence]')!.textContent).toBe(
    'Verify signed IDE receipt handoff'
  )
  expect(document.querySelector('[data-next-action-done-when-count]')!.textContent).toBe(
    '1 of 3 Done When'
  )
  expect(document.querySelector('[data-next-action-done-when-open]')!.textContent).toBe(
    '· open: receipt signed, handoff logged'
  )
  expect(document.querySelectorAll('[data-next-action-pip="met"]')).toHaveLength(1)
  expect(document.querySelectorAll('[data-next-action-pip="open"]')).toHaveLength(2)
  expect(document.querySelector('[data-next-action-done-when-list]')).toBeNull()
})

it('reveals the read-only checklist on the toggle, and drops the inline open names', () => {
  render(<OutcomeLine chain={nextActionChainFixture()} onChainChanged={() => {}} door={door()} />)
  fireEvent.click(screen.getByRole('button', { name: /Done when conditions/ }))
  const items = [...document.querySelectorAll('[data-next-action-done-when-list] li')]
  expect(items.map((item) => item.querySelector('span')?.textContent)).toEqual([
    '✓ IDE build installed',
    '○ receipt signed',
    '○ handoff logged'
  ])
  expect(document.querySelector('[data-next-action-done-when-open]')).toBeNull()
})

it('opens the same checklist for another surface, such as a Verify row', () => {
  render(<OutcomeLine chain={nextActionChainFixture()} onChainChanged={() => {}} door={door()} />)
  act(() => openDoneWhenList('chain'))
  expect(document.querySelector('[data-next-action-done-when-list]')).toBeTruthy()
})

it('commits a reworded outcome with the revision it opened against, and bumps it', async () => {
  const chain = nextActionChainFixture()
  const committed: SessionChain[] = []
  const commit = vi.fn(async (_request: CommitRequest) => {
    const next = structuredClone(chain)
    next.outcomeSet!.revision += 1
    next.outcomeSet!.outcomes[0]!.title = 'Verified handoff'
    return next
  })
  render(
    <OutcomeLine
      chain={chain}
      onChainChanged={(next) => committed.push(next)}
      door={door({ commit })}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'edit' }))
  fireEvent.change(screen.getByLabelText('Outcome sentence'), {
    target: { value: 'Verified handoff' }
  })
  fireEvent.change(screen.getByLabelText('Done when condition 2'), {
    target: { value: 'signed receipt' }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(commit).toHaveBeenCalledTimes(1))
  const request = commit.mock.calls[0]![0]
  expect(request.expectedRevision).toBe(chain.outcomeSet!.revision)
  expect(request.outcomes[0]!.title).toBe('Verified handoff')
  expect(request.outcomes[0]!.conditions.map((condition) => condition.label)).toEqual([
    'IDE build installed',
    'signed receipt',
    'handoff logged'
  ])
  expect(committed).toHaveLength(1)
  expect(committed[0]!.outcomeSet!.revision).toBe(chain.outcomeSet!.revision + 1)
})

it('refuses to guess after a lost race: it shows the host refusal and reloads what is saved', async () => {
  const chain = nextActionChainFixture()
  const fresh = nextActionChainFixture(3)
  const commit = vi.fn(async (_request: CommitRequest): Promise<SessionChain> => {
    throw new Error('Outcome revision conflict.')
  })
  const reload = vi.fn(async () => fresh)
  const seen: SessionChain[] = []
  render(
    <OutcomeLine
      chain={chain}
      onChainChanged={(next) => seen.push(next)}
      door={door({ commit, reload })}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'edit' }))
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() =>
    expect(screen.getByRole('alert').textContent).toBe('Outcome revision conflict.')
  )
  expect(reload).toHaveBeenCalledWith(chain)
  expect(seen).toEqual([fresh])
  expect(document.querySelector('[data-next-action-outcome-editor]')).toBeTruthy()
})

it('shows no sentence and no pips for a conversation with no outcome, and never creates one unasked', () => {
  const commit = vi.fn()
  render(
    <OutcomeLine
      chain={nextActionChainlessFixture()}
      onChainChanged={() => {}}
      door={door({ commit })}
    />
  )
  expect(document.querySelector('[data-next-action-outcome-sentence]')).toBeNull()
  expect(document.querySelector('[data-next-action-outcome]')!.textContent).not.toContain(
    'No outcome yet'
  )
  expect(document.querySelector('[data-next-action-done-when]')).toBeNull()
  expect(screen.queryByRole('button', { name: 'edit' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Set outcome' }).hasAttribute('disabled')).toBe(false)
  expect(commit).not.toHaveBeenCalled()
})

/**
 * Brief 78 #1: "Set outcome" opens the editor empty; Save creates the set through the same door
 * at revision 0, as the first outcome the engine's own first commit would lower to — one
 * `my-review` criterion, no instructions, no actions.
 */
it('creates the first outcome from the empty editor through the commit door', async () => {
  const chain = nextActionChainlessFixture()
  const commit = vi.fn(
    async (request: CommitRequest) =>
      ({
        ...request.chain,
        outcomeSet: { revision: 1, outcomes: [{ ...request.outcomes[0]!, revision: 1 }] }
      }) as unknown as SessionChain
  )
  const seen: SessionChain[] = []
  render(
    <OutcomeLine chain={chain} onChainChanged={(next) => seen.push(next)} door={door({ commit })} />
  )
  fireEvent.click(screen.getByRole('button', { name: 'Set outcome' }))
  const sentence = screen.getByLabelText('Outcome sentence') as HTMLTextAreaElement
  expect(sentence.value).toBe('')
  expect(screen.queryByLabelText(/Done when condition/)).toBeNull()
  fireEvent.change(sentence, { target: { value: 'Ship the fold' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(commit).toHaveBeenCalledTimes(1))
  const request = commit.mock.calls[0]![0]
  expect(request.chain).toBe(chain)
  expect(request.expectedRevision).toBe(0)
  expect(request.outcomes).toHaveLength(1)
  const outcome = request.outcomes[0]!
  expect(outcome.title).toBe('Ship the fold')
  expect(outcome.finish).toBe('my-review')
  expect(outcome.instructions).toBeUndefined()
  expect(outcome.actions).toEqual([])
  expect(outcome.conditions).toEqual([
    { id: 'my-review', kind: 'review', target: outcome.id, label: 'I have reviewed the result' }
  ])
  expect(seen).toHaveLength(1)
  expect(document.querySelector('[data-next-action-outcome-editor]')).toBeNull()
})

it('refuses an empty sentence before the door is asked, and Escape closes the editor', async () => {
  const commit = vi.fn()
  render(
    <OutcomeLine
      chain={nextActionChainlessFixture()}
      onChainChanged={() => {}}
      door={door({ commit })}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'Set outcome' }))
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() =>
    expect(screen.getByRole('alert').textContent).toBe('Say what this conversation is pursuing.')
  )
  expect(commit).not.toHaveBeenCalled()
  fireEvent.keyDown(screen.getByLabelText('Outcome sentence'), { key: 'Escape' })
  expect(document.querySelector('[data-next-action-outcome-editor]')).toBeNull()
  expect(screen.getByRole('button', { name: 'Set outcome' })).toBeTruthy()
})

it('edits the chain the host lends when the conversation has none, and drops it on Cancel', async () => {
  const lent = nextActionChainlessFixture()
  const startChain = vi.fn(() => lent)
  const commit = vi.fn(async (request: CommitRequest) => request.chain)
  render(
    <OutcomeLine
      chain={null}
      onChainChanged={() => {}}
      door={door({ commit })}
      startChain={startChain}
    />
  )
  const set = screen.getByRole('button', { name: 'Set outcome' })
  expect(set.hasAttribute('disabled')).toBe(false)
  fireEvent.click(set)
  expect(startChain).toHaveBeenCalledOnce()
  expect(document.querySelector('[data-next-action-outcome-editor]')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(document.querySelector('[data-next-action-outcome-editor]')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Set outcome' }))
  fireEvent.change(screen.getByLabelText('Outcome sentence'), { target: { value: 'Ship it' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(commit).toHaveBeenCalledTimes(1))
  expect(commit.mock.calls[0]![0].chain).toBe(lent)
})

it('keeps Set outcome shut, and says why, when no chain can be built', () => {
  render(<OutcomeLine chain={null} onChainChanged={() => {}} door={door()} />)
  const set = screen.getByRole('button', { name: 'Set outcome' })
  expect(set.hasAttribute('disabled')).toBe(true)
  expect(set.getAttribute('title')).toBe('Set an outcome by queueing a block first.')
  fireEvent.click(set)
  expect(document.querySelector('[data-next-action-outcome-editor]')).toBeNull()
})

it('shows the current receipt and verification time beneath its met condition', () => {
  const chain = nextActionChainFixture()
  render(<OutcomeLine chain={chain} onChainChanged={() => {}} door={door()} />)
  act(() => openDoneWhenList(chain.id))
  const item = document.querySelector('[data-next-action-condition="met"]')!
  expect(item.querySelector('p')?.textContent).toContain('receipt:build')
  const time = item.querySelector('time')!
  expect(time.dateTime).toBe(new Date(1_700_000_000_000).toISOString())
  expect(time.textContent).toBe(clockLabel(1_700_000_000_000))
  expect(document.querySelector('[data-next-action-condition="open"] p')).toBeNull()
})

it('names the toggle for assistive tech and shows it beside the count, never alone', () => {
  render(<OutcomeLine chain={nextActionChainFixture()} onChainChanged={() => {}} door={door()} />)
  const toggle = screen.getByRole('button', { name: /Done when conditions/ })
  // Label in Name (WCAG 2.5.3): the accessible name starts with the visible "Details".
  expect(toggle.getAttribute('aria-label')).toMatch(/^Details/)
  expect(toggle.className).toContain('ml-auto')
  expect(toggle.textContent).toBe('Details▾')
  expect(toggle.parentElement).toBe(document.querySelector('[data-next-action-done-when]'))
  expect(toggle.parentElement!.className).toContain('flex-wrap')
  fireEvent.click(toggle)
  expect(toggle.textContent).toBe('Details▴')
  expect(toggle.getAttribute('aria-expanded')).toBe('true')
})

it('shows the person and the file by name, keeping the id and the full path in the title', () => {
  const chain = nextActionChainFixture(0)
  const path = '/Users/maintainer/omni/workspaces/session-handoff-live-0914/hat.html'
  chain.outcomeSet!.outcomes[0]!.conditions = [
    { id: 'person', kind: 'handoff', target: 'emp_sal_qa_test' },
    { id: 'file', kind: 'file', target: path }
  ]
  chain.steps = [
    {
      kind: 'handoff',
      id: 'handoff_1',
      status: 'queued',
      handoff: {
        revision: 1,
        taskId: null,
        taskTitle: '',
        sessionLabel: 'hat',
        recipients: [
          {
            employeeId: 'emp_sal_qa_test',
            name: 'Sal Test Blake Test',
            operationId: 'op_00000001',
            delivery: 'pending'
          }
        ],
        deliverables: { kind: 'files', paths: [] },
        includeSummary: false,
        note: '',
        savedAt: 1
      }
    }
  ]
  render(<OutcomeLine chain={chain} onChainChanged={() => {}} door={door()} />)
  const open = document.querySelector('[data-next-action-done-when-open]')!
  expect(open.textContent).toBe('· open: Sal Test Blake Test, hat.html')
  expect(open.className).toContain('break-words')
  expect(screen.getByText('Sal Test Blake Test').getAttribute('title')).toBe('emp_sal_qa_test')
  expect(screen.getByText('hat.html').getAttribute('title')).toBe(path)
  expect(open.textContent).not.toContain('emp_sal_qa_test')
  expect(open.textContent).not.toContain('/Users/')
})

it('answers the owner’s own review from the checklist a "Review" request opens', async () => {
  const chain = nextActionChainFixture(0)
  chain.outcomeSet!.outcomes[0]!.conditions = [
    { id: 'mine', kind: 'review', target: 'outcome', version: 'v7', label: 'I reviewed it' },
    { id: 'theirs', kind: 'review', target: 'emp_1', recipientId: 'emp_1', version: 'v7' }
  ]
  const next = structuredClone(chain)
  next.outcomeSet!.revision += 1
  const approveReview = vi.fn(async () => next)
  const onChainChanged = vi.fn()
  render(
    <OutcomeLine chain={chain} onChainChanged={onChainChanged} door={door({ approveReview })} />
  )
  act(() => openDoneWhenList(chain.id))
  // A named reviewer's condition is theirs to answer: only the owner's own carries the button.
  const approve = screen.getAllByRole('button', { name: 'Approve review' })
  expect(approve).toHaveLength(1)
  expect(approve[0]!.getAttribute('data-next-action-approve-review')).toBe('mine')
  fireEvent.click(approve[0]!)
  await waitFor(() => expect(onChainChanged).toHaveBeenCalledWith(next))
  expect(approveReview).toHaveBeenCalledWith({
    id: 'chain',
    owner: chain,
    expectedRevision: chain.outcomeSet!.revision,
    outcomeId: 'outcome',
    conditionId: 'mine',
    version: 'v7'
  })
})

it('shows why an approval was refused instead of losing it', async () => {
  const chain = nextActionChainFixture(0)
  chain.outcomeSet!.outcomes[0]!.conditions = [
    { id: 'mine', kind: 'review', target: 'outcome', version: 'v7' }
  ]
  const approveReview = vi.fn(async () => {
    throw new Error('Outcome revision conflict.')
  })
  render(<OutcomeLine chain={chain} onChainChanged={() => {}} door={door({ approveReview })} />)
  act(() => openDoneWhenList(chain.id))
  fireEvent.click(screen.getByRole('button', { name: 'Approve review' }))
  await waitFor(() =>
    expect(screen.getByRole('alert').textContent).toBe('Outcome revision conflict.')
  )
})
