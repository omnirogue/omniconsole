// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UpNextPromptBlock } from '../../../../shared/up-next-types'
import { UpNextQueuedPromptFailure } from './UpNextQueuedPromptFailure'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

const block = (over: Partial<UpNextPromptBlock> = {}): UpNextPromptBlock => ({
  id: 'pq:e1',
  kind: 'prompt',
  state: 'failed',
  number: '',
  locked: false,
  text: 'Research the code',
  target: { kind: 'current' },
  when: 'after',
  queueEntryId: 'e1',
  failureReason: 'agent_prompt_stalled',
  ...over
})

const controller = () => ({
  disabled: false,
  remove: vi.fn(async () => true),
  requeue: vi.fn(async () => true)
})

afterEach(cleanup)

describe('a failed queued prompt in Up next', () => {
  it('offers Queue again and Dismiss when the queue is paused behind it', () => {
    const actions = controller()
    render(<UpNextQueuedPromptFailure block={block({ holdsQueue: true })} controller={actions} />)
    expect(
      screen
        .getByText('The queue is paused until you queue this again or dismiss it.')
        .getAttribute('title')
    ).toBe('The agent stopped responding before it started the task.')
    fireEvent.click(screen.getByRole('button', { name: 'Queue again' }))
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(actions.requeue).toHaveBeenCalledWith('pq:e1')
    expect(actions.remove).toHaveBeenCalledWith('pq:e1')
  })

  it('offers only Dismiss when a host did not mark it, showing the reason', () => {
    render(<UpNextQueuedPromptFailure block={block()} controller={controller()} />)
    expect(
      screen.getByText('The agent stopped responding before it started the task.')
    ).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Queue again' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy()
  })

  it('shows a code it has no words for as it is', () => {
    render(
      <UpNextQueuedPromptFailure
        block={block({ failureReason: 'brand_new_code' })}
        controller={controller()}
      />
    )
    expect(screen.getByText('brand_new_code')).toBeTruthy()
  })

  it('renders nothing for a prompt that did not fail', () => {
    const { container } = render(
      <UpNextQueuedPromptFailure block={block({ state: 'queued' })} controller={controller()} />
    )
    expect(container.innerHTML).toBe('')
  })
})
