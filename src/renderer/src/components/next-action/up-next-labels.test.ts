/**
 * The primary button says what pressing it does (v3 amendment 3).
 *
 * "Finish now" belongs to a lone Done while the session is IDLE. Live it read "Queue 1 new
 * block" instead, on a session with nothing running, nothing queued and one Done draft
 * (`evidence/na-live-phase1-20260918T063329Z` cli/24q_state_tree.txt: Now row "NOW idle claude ·
 * waiting for you", button "Queue 1 new block"): the condition asked the HEADER, which reads the
 * RUN — `failed` while an outcome carries an unclassified block, including a stale one from a
 * source refusal that has since cleared, which is exactly what that conversation was carrying
 * (`omni-data.json` chain `source_4caddd31…`: status blocked, "Source execution is
 * unverifiable…", `sourceReady: true`).
 */
import { expect, it } from 'vitest'
import {
  blockSecondary,
  clockLabel,
  primaryLabel,
  stateLabel,
  stoppedLabel
} from './up-next-labels'
import { agentFixture, upNextFixture } from './up-next-fixture'
import type { UpNextBlock, UpNextView } from '../../../../shared/up-next-types'

const done: UpNextBlock = {
  id: 'draft:done',
  kind: 'done',
  state: 'draft',
  number: '3',
  locked: false,
  finish: 'close'
}

/** One view, composed as the live run had it: two finished stages and a Done draft. */
function view(over: Partial<UpNextView>): UpNextView {
  return { ...upNextFixture('done'), ...over }
}

const finished = [
  agentFixture('first', { state: 'done', locked: true }),
  agentFixture('second', { state: 'done', locked: true })
]

it('reads "Finish now" for a lone Done while the Now row is idle', () => {
  expect(primaryLabel(view({ blocks: [done], now: { kind: 'idle', agent: 'claude' } }))).toBe(
    'Finish now'
  )
})

it('reads "Finish now" with finished work above it — the done strip is history', () => {
  expect(
    primaryLabel(view({ blocks: [...finished, done], now: { kind: 'idle', agent: 'claude' } }))
  ).toBe('Finish now')
})

it('still reads "Finish now" when a stale block is left on the header', () => {
  expect(
    primaryLabel(
      view({
        blocks: [...finished, done],
        header: { state: 'failed', failure: { code: 'unclassified' } },
        now: { kind: 'idle', agent: 'claude' }
      })
    )
  ).toBe('Finish now')
})

it('reads "Queue 1 new block" while the conversation is really working', () => {
  expect(
    primaryLabel(
      view({
        blocks: [...finished, done],
        header: { state: 'running' },
        now: { kind: 'current-work', agent: 'claude', label: 'Improve', elapsedMs: 60_000 }
      })
    )
  ).toBe('Queue 1 new block')
})

it('reads "Queue 1 new block" while a stage is the Now row', () => {
  expect(
    primaryLabel(
      view({
        blocks: [agentFixture('running', { state: 'running', locked: true }), done],
        header: { state: 'running', stage: { n: 1, of: 2 } },
        now: { kind: 'stage', blockId: 'running' }
      })
    )
  ).toBe('Queue 1 new block')
})

it('reads "Queue 2 new blocks" when the Done is not alone', () => {
  expect(
    primaryLabel(
      view({
        blocks: [agentFixture('draft:improve', { state: 'draft' }), done],
        now: { kind: 'idle', agent: 'claude' }
      })
    )
  ).toBe('Queue 2 new blocks')
})

it('leaves "Up to date" when nothing is composed', () => {
  expect(primaryLabel(view({ blocks: finished, now: { kind: 'idle' } }))).toBe('Up to date')
})

/**
 * A block's tag says its own state. "needs you" belonged to every `blocked` stage; it now belongs
 * only to the state an OPEN REQUEST produces, and every other stop says its own class.
 */
it('says "needs you" only for the state an open request produces', () => {
  expect(stateLabel('needs-you')).toBe('needs you')
  for (const state of ['recovering', 'waiting', 'failed', 'queued', 'running', 'done'] as const) {
    expect(stateLabel(state)).not.toMatch(/needs you/i)
  }
  expect(stateLabel('recovering')).toBe('recovering')
  expect(stateLabel('failed')).toBe('failed')
})

it('prints "stopped <time>" for every class of stopped stage, and for nothing else', () => {
  const at = Date.UTC(2026, 8, 18, 14, 31)
  for (const state of ['recovering', 'needs-you', 'failed', 'waiting'] as const) {
    expect(stoppedLabel(agentFixture('s', { state, progress: { stoppedAt: at } }))).toBe(
      `stopped ${clockLabel(at)}`
    )
  }
  // A stage that merely waits its turn carries no stop, so it is not a stopped stage.
  expect(stoppedLabel(agentFixture('s', { state: 'waiting' }))).toBe('')
  expect(stoppedLabel(agentFixture('s', { state: 'running', progress: { stoppedAt: at } }))).toBe(
    ''
  )
})

it('says a Done block closed or saved only once a window reported it', () => {
  const base = upNextFixture('closed')
  const block = (patch: Partial<UpNextBlock>): UpNextBlock =>
    ({ ...done, id: 'done', state: 'done', locked: true, ...patch }) as UpNextBlock
  expect(blockSecondary(block({}), base)).toBe('then close this session')
  expect(blockSecondary(block({ closedAt: 1 }), base)).toBe(`closed ${clockLabel(1)}`)
  expect(blockSecondary(block({ finish: 'save', savedAt: 1 }), base)).toBe(`saved ${clockLabel(1)}`)
})
