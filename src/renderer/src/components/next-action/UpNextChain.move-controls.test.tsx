// @vitest-environment happy-dom
/**
 * The ↑↓ on a row is a promise: pressing it moves the row, or it is not offered.
 *
 * Two moves the engine cannot make, and used to answer with an identical view or with copy
 * about the end of the track: a composed row that is not a prompt has nowhere above the first
 * queued block to go (R-10, `up-next-write.ts`), and a stage's prompt moves inside its own
 * stage and nowhere else (S-4, `up-next-stage-prompt-move.ts`). Both refuse in the engine;
 * these are the controls agreeing with it.
 */
import { cleanup, render, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { UpNextChainView } from './UpNextChain'
import { agentFixture, upNextFixture } from './up-next-fixture'
import type { UpNextController } from './use-up-next'
import type { UpNextBlock } from '../../../../shared/up-next-types'

afterEach(cleanup)

function controller(blocks: UpNextBlock[]): UpNextController {
  const write = () => vi.fn(async () => true)
  const view = upNextFixture('chain')
  view.blocks = blocks
  view.now = { kind: 'current-work', agent: 'claude', label: 'Implement' }
  return {
    view,
    disabled: false,
    error: null,
    append: write(),
    update: write(),
    reorder: write(),
    remove: write(),
    commit: write(),
    discardDrafts: write(),
    configureAfter: write()
  }
}

const row = (id: string): HTMLElement =>
  document.querySelector(`[data-up-next-block="${id}"]`)! as HTMLElement

const disabled = (id: string, control: 'Move up' | 'Move down'): boolean =>
  within(row(id)).getByRole('button', { name: control }).hasAttribute('disabled')

const promptBlock = (id: string, over: Partial<UpNextBlock> = {}): UpNextBlock =>
  ({
    id,
    kind: 'prompt',
    state: 'queued',
    number: '',
    locked: false,
    text: 'Then the ledger.',
    target: { kind: 'stage', blockId: 'node:one' },
    ...over
  }) as UpNextBlock

it('offers ↑ only where the engine can take the row', () => {
  render(
    <UpNextChainView
      controller={controller([
        agentFixture('node:one'),
        agentFixture('draft:after', { state: 'draft' }),
        promptBlock('draft:prompt', { state: 'draft', target: { kind: 'current' } })
      ])}
    />
  )

  // Nothing queued above the first stage to re-anchor to, and only a prompt may be pinned
  // ahead of the plan: the stage draft cannot rise, the prompt draft can.
  expect(disabled('draft:after', 'Move up')).toBe(true)
  expect(disabled('draft:prompt', 'Move up')).toBe(false)
})

it('withholds a stage prompt’s arrows at the stage boundary', () => {
  render(
    <UpNextChainView
      controller={controller([
        agentFixture('node:one'),
        promptBlock('sp:step_1:p1'),
        promptBlock('sp:step_1:p2'),
        agentFixture('node:two'),
        promptBlock('sp:step_2:p3', { target: { kind: 'stage', blockId: 'node:two' } })
      ])}
    />
  )

  // The row above the first prompt is its own stage, and the row below the last is the next
  // stage: neither is a prompt of this stage, so neither move exists.
  expect(disabled('sp:step_1:p1', 'Move up')).toBe(true)
  expect(disabled('sp:step_1:p1', 'Move down')).toBe(false)
  expect(disabled('sp:step_1:p2', 'Move up')).toBe(false)
  expect(disabled('sp:step_1:p2', 'Move down')).toBe(true)
  expect(disabled('sp:step_2:p3', 'Move up')).toBe(true)
  expect(disabled('sp:step_2:p3', 'Move down')).toBe(true)
})

const personBlock = (id: string, over: Partial<UpNextBlock> = {}): UpNextBlock =>
  ({
    id,
    kind: 'person',
    state: 'queued',
    number: '',
    locked: false,
    relationship: 'review',
    people: [{ id: 'emp_1', name: 'Jordan Taylor', initials: 'SG' }],
    receive: { files: true, transcript: false, createTaskCard: false },
    ...over
  }) as UpNextBlock

it('gives a queued Review the one move it has', () => {
  render(
    <UpNextChainView
      controller={controller([
        agentFixture('node:one'),
        promptBlock('sp:step_1:p1'),
        personBlock('step:handoff_1'),
        agentFixture('draft:held', { state: 'waiting' })
      ])}
    />
  )

  // ↑ takes the queued STAGE above it — but the row above here is that stage's own prompt,
  // which is not a move; and ↓ never is, because nothing the plan carries is below the people.
  expect(disabled('step:handoff_1', 'Move up')).toBe(true)
  expect(disabled('step:handoff_1', 'Move down')).toBe(true)

  cleanup()
  render(
    <UpNextChainView
      controller={controller([
        agentFixture('node:one'),
        agentFixture('node:two'),
        personBlock('step:handoff_1')
      ])}
    />
  )

  expect(disabled('step:handoff_1', 'Move up')).toBe(false)
  expect(disabled('step:handoff_1', 'Move down')).toBe(true)
})
