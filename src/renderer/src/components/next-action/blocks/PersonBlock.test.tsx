// @vitest-environment happy-dom
/**
 * SEND TO A PERSON: To, Note, Due and ONE checkbox, with the sentence that says what the tick
 * does. No relationship picker, no "What they receive" boxes, no communication type. The box
 * reads its default from where the block sits until the person touches it, every save sends
 * everything, and an older draft with a relationship and receive flags loads into the same form.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PersonBlock } from './PersonBlock'
import { agentFixture, upNextFixture } from '../up-next-fixture'
import type { UpNextController } from '../use-up-next'
import type {
  UpNextBlock,
  UpNextPersonBlock,
  UpNextView
} from '../../../../../shared/up-next-types'

vi.mock('@/components/next-step/use-handoff-people', () => ({
  useHandoffPeople: () => ({
    people: {
      phase: 'ready',
      value: [
        { id: 'emp_sal', name: 'Jordan Taylor', photo_url: 'https://example.com/sal.png' },
        { id: 'emp_iris', name: 'Iris Allen' }
      ]
    },
    reload: vi.fn()
  })
}))
afterEach(cleanup)

const update = vi.fn(async () => true)
const controller = { update, disabled: false } as unknown as UpNextController
beforeEach(() => update.mockClear())

const SAL = { id: 'emp_sal', name: 'Jordan Taylor', initials: 'SG' }
const EVERYTHING = { files: true, transcript: true, createTaskCard: false }

function send(patch: Partial<UpNextPersonBlock> = {}): UpNextPersonBlock {
  return {
    id: 'draft:person',
    kind: 'person',
    state: 'draft',
    number: '1',
    locked: false,
    relationship: null,
    people: [SAL],
    receive: EVERYTHING,
    ...patch
  }
}
const viewOf = (...blocks: UpNextBlock[]): UpNextView => ({ ...upNextFixture('busy'), blocks })
const after = agentFixture('draft:stage', { state: 'draft' })
const box = () =>
  screen.getByRole('checkbox', { name: 'Wait for their OK before my next steps run' })
const sentence = () => document.querySelector('[data-person-send-consequence]')!.textContent

function mount(block: UpNextPersonBlock, ...rest: UpNextBlock[]) {
  return render(<PersonBlock block={block} view={viewOf(block, ...rest)} controller={controller} />)
}

it('is one send form: To, Note, Due, the checkbox and what it sends', () => {
  mount(send())
  expect(screen.getByText('Send to a person')).toBeTruthy()
  expect(screen.getByRole('group', { name: 'To' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Remove Jordan Taylor' })).toBeTruthy()
  const note = screen.getByLabelText('Note') as HTMLTextAreaElement
  expect(note.placeholder).toBe('What I need from you…')
  expect(screen.getByLabelText('Due (optional)')).toBeTruthy()
  expect(box()).toBeTruthy()
  expect(screen.getByText('Sends everything: files · summary · full conversation')).toBeTruthy()
})

it('says what really goes when this host cannot read the conversation, and still sends', () => {
  const block = send()
  const view = (sendsConversation?: boolean): UpNextView => ({
    ...viewOf(block),
    ...(sendsConversation === undefined ? {} : { sendsConversation })
  })
  const line = () => document.querySelector('[data-person-send-everything]')!.textContent
  render(<PersonBlock block={block} view={view(false)} controller={controller} />)
  expect(line()).toBe("Sends files · summary. The conversation can't be included from here.")
  // Nothing about it is refused: the form is the same, only the promise is honest.
  expect(box().hasAttribute('disabled')).toBe(false)
  cleanup()
  for (const readable of [true, undefined]) {
    render(<PersonBlock block={block} view={view(readable)} controller={controller} />)
    expect(line()).toBe('Sends everything: files · summary · full conversation')
    cleanup()
  }
})

it('offers no relationship picker, no receive boxes and no communication type', () => {
  for (const relationship of [null, 'handoff', 'review'] as const) {
    mount(send({ relationship }), after)
    for (const gone of [
      'Hand off',
      'Review',
      'What they receive',
      'Work files and the final summary',
      'The conversation transcript',
      'Create a task card for this',
      'Communication type',
      'Pick one to continue.'
    ]) {
      expect(screen.queryByText(gone)).toBeNull()
    }
    expect(screen.queryByLabelText('Communication type')).toBeNull()
    expect(screen.getAllByRole('checkbox')).toHaveLength(1)
    cleanup()
  }
})

describe('the default tick', () => {
  it('is unticked when the send is the last block', () => {
    mount(send())
    expect(box().getAttribute('aria-checked')).toBe('false')
    expect(sentence()).toBe("It becomes Jordan Taylor's.")
  })

  it('is ticked when blocks follow it', () => {
    mount(send(), after)
    expect(box().getAttribute('aria-checked')).toBe('true')
    expect(sentence()).toBe('Your next step will PAUSE until Jordan Taylor says OK.')
  })

  it('is stored only when the person touches it, with everything sent', () => {
    mount(send(), after)
    fireEvent.click(box())
    expect(update).toHaveBeenLastCalledWith('draft:person', {
      kind: 'person',
      relationship: 'handoff',
      receive: EVERYTHING
    })
  })

  it('never promises a pause for work that is already queued', () => {
    // [A1 running, send, A2 queued]: the people are the plan's finish, so A2 runs before they are
    // asked. Only work the commit can hold is one of "your next steps".
    const block = send()
    const blocks = [agentFixture('node:one', { state: 'running' }), block, agentFixture('node:two')]
    render(<PersonBlock block={block} view={{ ...viewOf(), blocks }} controller={controller} />)
    expect(box().getAttribute('aria-checked')).toBe('false')
    expect(sentence()).toBe("It becomes Jordan Taylor's.")
    cleanup()
    const ticked = send({ relationship: 'review' })
    render(
      <PersonBlock
        block={ticked}
        view={{ ...viewOf(), blocks: [ticked, agentFixture('node:two'), after] }}
        controller={controller}
      />
    )
    expect(sentence()).toBe('Your next step will PAUSE until Jordan Taylor says OK.')
  })

  it('never changes a choice the person made, whatever follows it', () => {
    mount(send({ relationship: 'handoff' }), after, agentFixture('draft:two', { state: 'draft' }))
    expect(box().getAttribute('aria-checked')).toBe('false')
    expect(sentence()).toBe("It becomes Jordan Taylor's. Your next steps won't run.")
    cleanup()
    mount(send({ relationship: 'review' }))
    expect(box().getAttribute('aria-checked')).toBe('true')
    expect(sentence()).toBe("Nothing else runs after this; you'll see their answer here.")
    fireEvent.click(box())
    expect(update).toHaveBeenLastCalledWith('draft:person', {
      kind: 'person',
      relationship: 'handoff',
      receive: EVERYTHING
    })
  })
})

describe('an older draft', () => {
  it.each([
    ['review', 'true'],
    ['handoff', 'false']
  ] as const)(
    'with %s loads ticked=%s and sends everything on its next save',
    (relationship, ticked) => {
      const old = send({
        relationship,
        receive: { files: false, transcript: false, createTaskCard: false, note: 'Old note' }
      })
      mount(old)
      expect(box().getAttribute('aria-checked')).toBe(ticked)
      const note = screen.getByLabelText('Note') as HTMLTextAreaElement
      expect(note.value).toBe('Old note')
      fireEvent.change(note, { target: { value: 'Only the signing matters.' } })
      fireEvent.blur(note)
      // The note travels on its own: the relationship the person chose is not rewritten.
      expect(update).toHaveBeenLastCalledWith('draft:person', {
        kind: 'person',
        receive: { ...EVERYTHING, note: 'Only the signing matters.' }
      })
    }
  )
})

describe('To', () => {
  it('takes one or several people and drops one from its chip', () => {
    mount(send({ relationship: 'handoff' }))
    fireEvent.click(screen.getByRole('button', { name: 'Iris Allen' }))
    expect(update).toHaveBeenLastCalledWith('draft:person', {
      kind: 'person',
      people: [
        { id: 'emp_sal', name: 'Jordan Taylor' },
        { id: 'emp_iris', name: 'Iris Allen' }
      ],
      receive: EVERYTHING
    })
    fireEvent.click(screen.getByRole('button', { name: 'Remove Jordan Taylor' }))
    expect(update).toHaveBeenLastCalledWith('draft:person', {
      kind: 'person',
      people: [],
      receive: EVERYTHING
    })
  })

  it('filters the roster by name while keeping the recipient photo', () => {
    const mounted = mount(send({ people: [] }))
    fireEvent.change(screen.getByLabelText('Add a person…'), { target: { value: 'sal' } })
    expect(screen.getByRole('button', { name: 'Jordan Taylor' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Iris Allen' })).toBeNull()
    expect(mounted.container.querySelector('img')?.getAttribute('src')).toBe(
      'https://example.com/sal.png'
    )
  })
})

it('shows a sent block as what went, to whom, with no form', () => {
  mount(
    send({
      id: 'step:handoff',
      state: 'queued',
      relationship: 'review',
      receive: { ...EVERYTHING, note: 'Check the totals.' }
    })
  )
  expect(screen.queryByRole('checkbox')).toBeNull()
  expect(screen.getByText('To: Jordan Taylor')).toBeTruthy()
  expect(screen.getByText('Check the totals.')).toBeTruthy()
})
