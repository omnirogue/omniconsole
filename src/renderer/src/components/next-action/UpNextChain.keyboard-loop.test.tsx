// @vitest-environment happy-dom
/**
 * Sal, 2026-09-18: "confusing that Up next is before the Now" — the Now row is rendered first,
 * then the UP NEXT heading with its notation, then what is queued, all on the one rail.
 * Brief 78 #8, the keyboard loop: + Prompt / + Agent / + Person open the new block and put
 * the caret in its first field; Queue / Send now / Finish now hand focus back to the
 * conversation's input (the chat composer on Chat, the terminal on Terminal).
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { UpNextChainView } from './UpNextChain'
import { upNextFixture } from './up-next-fixture'
import { focusConversationInput } from './up-next-focus'
import type { UpNextController } from './use-up-next'
import type { UpNextBlock, UpNextView } from '../../../../shared/up-next-types'

// These cover the hand composer itself, which ships behind a flag that is off.
vi.mock('@/components/next-action/up-next-composer-flag', () => ({
  UP_NEXT_COMPOSER_ENABLED: true
}))

afterEach(cleanup)

function controller(view: UpNextView): UpNextController {
  const write = () => vi.fn(async () => true)
  return {
    view,
    error: null,
    disabled: false,
    append: write(),
    update: write(),
    reorder: write(),
    remove: write(),
    commit: write(),
    discardDrafts: write(),
    configureAfter: write()
  }
}

const before = (a: Element, b: Element): boolean =>
  Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)

it('renders the Now row before the UP NEXT heading, and the heading before the queue', () => {
  render(<UpNextChainView controller={controller(upNextFixture('busy'))} />)
  const track = document.querySelector('[data-up-next-track]')!
  const now = document.querySelector('[data-up-next-now]')!
  const heading = document.querySelector('[data-up-next-heading]')!
  const slot = screen.getByText('+ next block goes here')
  expect(track.contains(now) && track.contains(heading)).toBe(true)
  expect(before(now, heading)).toBe(true)
  expect(before(heading, slot)).toBe(true)
  expect(heading.querySelector('h3')!.textContent).toBe('Up next')
  expect(heading.querySelector('[data-up-next-notation]')).toBeTruthy()
})

it('puts a running stage that is Now above the heading too, with the queued rows under it', () => {
  const view = upNextFixture('running')
  render(<UpNextChainView controller={controller(view)} />)
  const nowId = view.now.kind === 'stage' ? view.now.blockId : ''
  const now = document.querySelector(`[data-up-next-block="${nowId}"]`)!
  const heading = document.querySelector('[data-up-next-heading]')!
  expect(before(now, heading)).toBe(true)
  for (const row of document.querySelectorAll('[data-up-next-block]')) {
    if (row !== now && row.getAttribute('data-state') !== 'done') {
      expect(before(heading, row)).toBe(true)
    }
  }
  // The run's phase line stays with the heading, not above the Now row.
  const status = document.querySelector('[data-up-next-header-status]')
  if (status) {
    expect(before(heading, status)).toBe(true)
  }
})

it('keeps the heading with no view, over the loading line', () => {
  const c = controller(upNextFixture('busy'))
  c.view = null
  render(<UpNextChainView controller={c} />)
  expect(document.querySelector('[data-up-next-heading] h3')!.textContent).toBe('Up next')
  expect(screen.getByRole('status').textContent).toBe('Loading Up next…')
  expect(document.querySelector('[data-up-next-track]')).toBeNull()
})

it('+ Prompt opens the new block and puts the caret in its text', async () => {
  const c = controller(upNextFixture('busy'))
  const mounted = render(<UpNextChainView controller={c} />)
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: '+ Prompt' }))
  })
  expect(c.append).toHaveBeenCalledOnce()
  const added: UpNextBlock = {
    id: 'draft:new',
    kind: 'prompt',
    state: 'draft',
    number: '1',
    locked: false,
    text: 'Is there anything else we can do to improve?',
    target: { kind: 'current' },
    when: 'after'
  }
  // The host answers with the view that now holds the block; the row opens and its field wins.
  mounted.rerender(
    <UpNextChainView
      controller={{
        ...c,
        view: { ...c.view!, blocks: [added], draftCount: 1 }
      }}
    />
  )
  const row = document.querySelector('[data-up-next-row="draft:new"]')!
  expect(row.getAttribute('aria-expanded')).toBe('true')
  const field = screen.getByLabelText('Prompt text')
  expect(document.activeElement).toBe(field)
  expect(row.closest('[data-up-next-block]')!.contains(field)).toBe(true)
})

it('Queue hands focus back to the chat composer of the structured host', async () => {
  const view = upNextFixture('busy')
  view.blocks = [
    {
      id: 'draft:head',
      kind: 'prompt',
      state: 'draft',
      number: '1',
      locked: false,
      text: 'Continue',
      target: { kind: 'current' },
      when: 'after'
    }
  ]
  view.draftCount = 1
  const c = controller(view)
  render(
    <div data-native-chat-root="true">
      <UpNextChainView controller={c} />
      <textarea data-native-chat-composer-input="" aria-label="Composer" />
    </div>
  )
  const queue = screen.getByRole('button', { name: 'Queue 1 new block' })
  queue.focus()
  expect(document.activeElement).toBe(queue)
  fireEvent.click(queue)
  await waitFor(() => expect(c.commit).toHaveBeenCalledOnce())
  await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Composer')))
})

it('leaves focus alone when the commit is refused', async () => {
  const view = upNextFixture('busy')
  view.blocks = [
    {
      id: 'draft:head',
      kind: 'prompt',
      state: 'draft',
      number: '1',
      locked: false,
      text: 'Continue',
      target: { kind: 'current' },
      when: 'after'
    }
  ]
  view.draftCount = 1
  const c = controller(view)
  c.commit = vi.fn(async () => false)
  render(
    <div data-native-chat-root="true">
      <UpNextChainView controller={c} />
      <textarea data-native-chat-composer-input="" aria-label="Composer" />
    </div>
  )
  const queue = screen.getByRole('button', { name: 'Queue 1 new block' })
  queue.focus()
  fireEvent.click(queue)
  await waitFor(() => expect(c.commit).toHaveBeenCalledOnce())
  expect(document.activeElement).toBe(queue)
})

const LEAF = '4e0f8f5a-1c3b-4a6e-9c2d-7b1f0e5d3a21'

function ptyHost(chatVisible: boolean): HTMLElement {
  document.body.innerHTML = `
    <div>
      <div data-session-work-rail="tab-1:${LEAF}"><section data-up-next-chain></section></div>
      <div data-terminal-tab-id="tab-1">
        <div data-leaf-id="${LEAF}">
          <div class="native-chat-pane-shell" aria-hidden="${chatVisible ? 'false' : 'true'}">
            <textarea data-native-chat-composer-input="" aria-label="Composer"></textarea>
          </div>
          <textarea class="xterm-helper-textarea" aria-label="Terminal"></textarea>
        </div>
        <div data-leaf-id="other">
          <textarea class="xterm-helper-textarea" aria-label="Other terminal"></textarea>
        </div>
      </div>
    </div>`
  return document.querySelector('[data-up-next-chain]')!
}

it('from the PTY rail, returns focus to the chat composer on Chat and to the terminal on Terminal', () => {
  expect(focusConversationInput(ptyHost(true))).toBe(true)
  expect(document.activeElement).toBe(screen.getByLabelText('Composer'))
  expect(focusConversationInput(ptyHost(false))).toBe(true)
  expect(document.activeElement).toBe(screen.getByLabelText('Terminal'))
})

it('has nowhere to go from a popover or card mount, and says so', () => {
  document.body.innerHTML = '<div><section data-up-next-chain></section></div>'
  expect(focusConversationInput(document.querySelector('[data-up-next-chain]'))).toBe(false)
  expect(focusConversationInput(null)).toBe(false)
})

it('compact Add preserves every existing kind and the real append and focus path', async () => {
  const c = controller(upNextFixture('busy'))
  const mounted = render(<UpNextChainView controller={c} compactAdd />)
  expect(screen.queryByRole('button', { name: '+ Prompt' })).toBeNull()
  const add = screen.getByRole('button', { name: 'Add' })
  fireEvent.click(add)
  for (const name of ['+ Prompt', '+ Agent Review', '+ Agent Handoff', '+ Person']) {
    expect(screen.getByRole('button', { name })).toBeTruthy()
  }
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: '+ Prompt' }))
  })
  expect(c.append).toHaveBeenCalledWith({
    kind: 'prompt',
    text: 'Is there anything else we can do to improve?',
    when: 'after'
  })
  expect(add.getAttribute('aria-expanded')).toBe('false')
  const added: UpNextBlock = {
    id: 'draft:compact',
    kind: 'prompt',
    state: 'draft',
    number: '1',
    locked: false,
    text: 'Keep this prompt',
    target: { kind: 'current' },
    when: 'after'
  }
  mounted.rerender(
    <UpNextChainView
      controller={{
        ...c,
        view: { ...c.view!, blocks: [added], draftCount: 1 }
      }}
      compactAdd
    />
  )
  expect(document.activeElement).toBe(screen.getByLabelText('Prompt text'))
})
