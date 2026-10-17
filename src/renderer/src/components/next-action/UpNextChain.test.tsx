import { UpNextOutcomeContext } from './up-next-outcome-context'
import { useDoneWhenListStore } from './use-done-when-list'
// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { UpNextChainView } from './UpNextChain'
import { upNextFixture } from './up-next-fixture'
import type { UpNextController } from './use-up-next'
import { upNextNotation } from '../../../../shared/up-next-summary'
import { upNextWithoutFinishBlock } from './up-next-without-finish-block'
import { UP_NEXT_WRITE_UNAVAILABLE } from '../../../../shared/up-next-types'

// These cover the hand composer itself, which ships behind a flag that is off.
vi.mock('@/components/next-action/up-next-composer-flag', () => ({
  UP_NEXT_COMPOSER_ENABLED: true
}))

vi.mock('@/components/next-step/SessionFinishFields', () => ({
  SavedFolderChooser: ({
    onChange
  }: {
    onChange: (value: { action: 'save'; folderId: string }) => void
  }) => (
    <button onClick={() => onChange({ action: 'save', folderId: 'folder-1' })}>
      Choose folder
    </button>
  )
}))
afterEach(cleanup)
function controller(scenario: string): UpNextController {
  const write = () => vi.fn(async () => true)
  return {
    view: upNextFixture(scenario),
    error: null,
    disabled: false,
    setWhenFinished: write(),
    append: write(),
    update: write(),
    reorder: write(),
    remove: write(),
    commit: write(),
    discardDrafts: write(),
    configureAfter: write()
  }
}
const STOPPED = ['recovering', 'waiting', 'needs-you', 'failed']
const FINISHED = ['completed', 'closed', 'saved']
for (const scenario of ['busy', 'chain', 'review', 'running', 'done', ...STOPPED, ...FINISHED]) {
  it(`renders host structure and notation: ${scenario}`, () => {
    const c = controller(scenario)
    render(<UpNextChainView controller={c} />)
    expect(document.querySelector('[data-up-next-notation]')?.textContent ?? '').toBe(
      upNextNotation(upNextWithoutFinishBlock(c.view!))
    )
    expect(document.querySelector('[data-up-next-summary]')?.textContent).toBeTruthy()
    if (scenario === 'busy') {
      expect(screen.getByText('+ next block goes here')).toBeTruthy()
      expect(screen.getByText('…then waits for you · tab stays open')).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Up to date' }).hasAttribute('disabled')).toBe(true)
    }
    if (scenario === 'chain') {
      // Each nested number twice: the rail pill (decorative) and the row's own sr-only number.
      expect(screen.getAllByText('2.1')).toHaveLength(2)
      expect(screen.getAllByText('2.3')).toHaveLength(2)
      expect(document.querySelectorAll('[data-end-cap]')).toHaveLength(1)
      expect(screen.getByRole('button', { name: '+ Prompt' }).title).toBe(
        'A send that doesn\'t wait ends this track. Tick "Wait for their OK" to keep going.'
      )
      expect(document.querySelector('[data-up-next-summary]')!.textContent).toBe(
        '3 stages · 6 executions · 3 prompts · 1 person · 3 at once in stage 2 · after current work'
      )
    }
    if (scenario === 'review') {
      // The host names the current agent, so the collapsed secondary names it too (S-23).
      expect(screen.getByText('to claude when it resumes after the review')).toBeTruthy()
      for (const name of ['+ Agent Review', '+ Agent Handoff']) {
        expect(screen.getByRole('button', { name }).hasAttribute('disabled')).toBe(false)
      }
    }
    if (scenario === 'running' || STOPPED.includes(scenario)) {
      const id = scenario === 'running' ? 'review' : 'verify'
      // A running stage opens on a click; a stopped one is already open so its reason is read.
      if (scenario === 'running') {
        fireEvent.click(document.querySelector(`[data-up-next-row="${id}"]`)!)
      }
      expect(screen.getByRole('button', { name: 'Configure a stage after this' })).toBeTruthy()
      expect(
        within(document.querySelector(`[data-up-next-block="${id}"]`)! as HTMLElement).queryByRole(
          'button',
          { name: 'Move up' }
        )
      ).toBeNull()
      expect(document.querySelector('[data-up-next-block="first"]')).toBeNull()
    }
    if (scenario === 'done') {
      expect(document.querySelector('[data-up-next-row="done"]')).toBeNull()
      expect(
        screen.getByRole('button', { name: 'Close session' }).getAttribute('aria-pressed')
      ).toBe('true')
      expect(screen.getByRole('button', { name: 'Up to date' })).toBeTruthy()
      for (const name of ['+ Agent Review', '+ Agent Handoff']) {
        expect(screen.getByRole('button', { name }).hasAttribute('disabled')).toBe(false)
      }
    }
    if (FINISHED.includes(scenario)) {
      // A finished run reads the same whether or not its session was closed: history, no add bar.
      expect(document.querySelector('[data-up-next-add]')).toBeNull()
      expect(document.querySelectorAll('[data-state="done"]')).toHaveLength(2)
      expect(screen.queryByRole('button', { name: 'Up to date' })).toBeNull()
      expect(document.querySelector('[data-up-next-now]')).toBeNull()
    }
  })
}
it('takes row keyboard actions without crossing Now or an end cap', () => {
  const c = controller('chain')
  render(<UpNextChainView controller={c} />)
  const first = document.querySelector('[data-up-next-row="improve"]')!
  fireEvent.keyDown(first, { key: 'ArrowUp' })
  expect(c.reorder).not.toHaveBeenCalled()
  fireEvent.keyDown(first, { key: 'ArrowDown' })
  expect(c.reorder).toHaveBeenCalledWith('improve', 1)
  fireEvent.keyDown(first, { key: 'Enter' })
  expect(first.getAttribute('aria-expanded')).toBe('true')
  fireEvent.keyDown(first, { key: 'Delete' })
  expect(c.remove).toHaveBeenCalledWith('improve')
})
it('shows When only on a head prompt', () => {
  const c = controller('chain')
  render(<UpNextChainView controller={c} />)
  fireEvent.click(document.querySelector('[data-up-next-row="prompt"]')!)
  expect(screen.queryByRole('group', { name: 'When' })).toBeNull()
})
it('renders host refusal as a message and disables writes', () => {
  const c = controller('busy')
  c.disabled = true
  c.error = UP_NEXT_WRITE_UNAVAILABLE
  render(<UpNextChainView controller={c} />)
  expect(screen.getByRole('alert').textContent).toBe(UP_NEXT_WRITE_UNAVAILABLE)
  expect(screen.getByRole('button', { name: '+ Prompt' }).hasAttribute('disabled')).toBe(true)
})
for (const state of ['idle', 'running'] as const) {
  it(`shows exact head timing labels while ${state}`, () => {
    const c = controller('busy')
    c.view!.header.state = state
    c.view!.blocks = [
      {
        kind: 'prompt',
        id: 'head',
        text: 'Continue',
        state: 'draft',
        locked: false,
        number: '1',
        target: { kind: 'current' },
        when: state === 'idle' ? 'now' : 'after'
      }
    ]
    c.view!.draftCount = 1
    render(<UpNextChainView controller={c} />)
    fireEvent.click(document.querySelector('[data-up-next-row="head"]')!)
    const group = screen.getByRole('group', { name: 'When' })
    const labels = within(group)
      .getAllByRole('button')
      .map((button) => button.textContent)
    expect(labels).toEqual(
      state === 'idle'
        ? ['Now (default)', 'After current work']
        : ['After current work (default)', 'Now — interrupts the running agent']
    )
    expect(
      screen.getByRole('button', {
        name: state === 'idle' ? 'Send now' : 'Queue 1 new block'
      })
    ).toBeTruthy()
  })
}
it('shows a legacy finish as a setting, with no Finish now action', () => {
  const c = controller('done')
  c.view!.blocks = c.view!.blocks.filter((block) => block.kind === 'done')
  render(<UpNextChainView controller={c} />)
  expect(screen.queryByRole('button', { name: 'Finish now' })).toBeNull()
})
it('does not offer When after a person review', () => {
  const c = controller('review')
  render(<UpNextChainView controller={c} />)
  fireEvent.click(document.querySelector('[data-up-next-row="resume"]')!)
  expect(screen.queryByRole('group', { name: 'When' })).toBeNull()
})
it('keeps Advanced fields absent until disclosed', () => {
  const c = controller('chain')
  render(<UpNextChainView controller={c} />)
  fireEvent.click(document.querySelector('[data-up-next-row="review"]')!)
  expect(screen.queryByText('Rounds')).toBeNull()
  expect(screen.queryByText('Reads from')).toBeNull()
  expect(screen.getByText('Advanced')).toBeTruthy()
})

it('opens the Outcome head checklist from a Verify output', () => {
  const c = controller('chain')
  render(
    <UpNextOutcomeContext value="chain">
      <UpNextChainView controller={c} />
    </UpNextOutcomeContext>
  )
  fireEvent.click(screen.getByRole('button', { name: 'Done when conditions' }))
  expect(useDoneWhenListStore.getState().openChainId).toBe('chain')
  expect(screen.getByRole('button', { name: 'Done when conditions' }).textContent).toContain('▴')
  fireEvent.click(screen.getByRole('button', { name: 'Done when conditions' }))
  expect(useDoneWhenListStore.getState().openChainId).toBeNull()
  expect(
    screen.getByRole('button', { name: 'Done when conditions' }).getAttribute('aria-expanded')
  ).toBe('false')
})
it.each(['council', 'best-of'] as const)(
  'renders one %s block with three measured seats',
  (shape) => {
    const c = controller('running')
    const stage = c.view!.blocks.find(
      (block) => block.kind === 'agent' && block.state === 'running'
    )!
    if (stage.kind !== 'agent') {
      throw new Error('missing fixture stage')
    }
    stage.shape = shape
    stage.n = 3
    stage.progress = {
      seats: [1, 2, 3].map((n) => ({
        id: `seat-${n}`,
        state: 'done',
        verdict: `verdict-${n}`
      })),
      verdictSummary: 'All agree'
    }
    render(<UpNextChainView controller={c} />)
    expect(document.querySelectorAll(`[data-up-next-row="${stage.id}"]`)).toHaveLength(1)
    fireEvent.click(document.querySelector(`[data-up-next-row="${stage.id}"]`)!)
    expect(screen.getByText('verdict-1', { exact: false })).toBeTruthy()
    expect(screen.getByText('verdict-2', { exact: false })).toBeTruthy()
    expect(screen.getByText('verdict-3', { exact: false })).toBeTruthy()
    // The verdict is on the row's line (truncating, with its title) and in full in the body.
    expect(document.querySelector('[data-up-next-verdict-summary]')!.textContent).toBe('All agree')
    expect(
      document
        .querySelector(`[data-up-next-block="${stage.id}"] [data-up-next-secondary]`)!
        .getAttribute('title')
    ).toContain('All agree')
  }
)

it('saves the finish setting below the add bar without appending or queuing a block', () => {
  const c = controller('busy')
  const { rerender } = render(<UpNextChainView controller={c} />)
  const setting = document.querySelector('[data-next-action-when-finished]')!
  const bar = document.querySelector('[data-up-next-add]')!
  expect(bar.compareDocumentPosition(setting) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(setting.closest('[data-up-next-track]')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Save session' }))
  expect(c.setWhenFinished).toHaveBeenCalledWith({ action: 'save' })
  expect(c.append).not.toHaveBeenCalled()
  expect(c.commit).not.toHaveBeenCalled()
  c.whenFinished = { action: 'save' }
  rerender(<UpNextChainView controller={c} />)
  expect(screen.queryByText('…then waits for you · tab stays open')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Choose folder' }))
  expect(c.setWhenFinished).toHaveBeenCalledWith({
    action: 'save',
    folderId: 'folder-1'
  })
})

it('offers the host block kinds, agents split by intent, without snooze or publishing commands', () => {
  render(<UpNextChainView controller={controller('busy')} />)
  const bar = document.querySelector('[data-up-next-add]') as HTMLElement
  expect(
    within(bar)
      .getAllByRole('button')
      .map((button) => button.textContent)
  ).toEqual(['+ Prompt', '+ Agent Review', '+ Agent Handoff', '+ Person'])
  expect(
    screen.queryByRole('button', {
      name: /Snooze|Wait later|Publish|Merge|Deploy/
    })
  ).toBeNull()
})
