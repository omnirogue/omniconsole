/**
 * The Now segment of the notation says what is happening — in words, always.
 *
 * `UpNextNow` leaves `label` empty when the host cannot read what the agent is doing, and
 * `agent` empty when it cannot even name it. A busy pane with no readable prompt therefore
 * rendered as a bare `●`: a glyph with nothing after it, and the one row the person reads to
 * know whether anything is running at all.
 */
import { expect, it } from 'vitest'
import { upNextNotation, upNextSummary, type UpNextSummaryInput } from './up-next-summary'
import type { UpNextAgentBlock, UpNextBlockState } from './up-next-types'

const busy = (now: { agent: string; label: string }): UpNextSummaryInput => ({
  blocks: [],
  header: { state: 'running' },
  now: { kind: 'current-work', ...now }
})

it.each([
  { agent: 'claude', label: 'Signing the receipts', shown: '● Signing the receipts' },
  { agent: 'claude', label: '', shown: '● claude' },
  { agent: '', label: '', shown: '● working' }
])('names $shown', ({ agent, label, shown }) => {
  expect(upNextNotation(busy({ agent, label }))).toBe(shown)
})

const stage = (id: string, patch: Partial<UpNextAgentBlock> = {}): UpNextAgentBlock => ({
  id,
  kind: 'agent',
  state: 'queued',
  number: '',
  locked: false,
  template: 'improve',
  shape: 'solo',
  n: 1,
  instruction: 'Improve the result.',
  output: 'result',
  intent: 'handoff',
  advanced: {},
  promptCount: 0,
  ...patch
})

/**
 * A stop says its class in the notation too: ▲ for the two stops nothing clears by itself (an
 * open request, an honest failure), ↻ while the host is recovering, and nothing for a wait.
 */
it.each<[UpNextBlockState, string]>([
  ['needs-you', '▲ ✨ Improve'],
  ['failed', '▲ ✨ Improve'],
  ['recovering', '↻ ✨ Improve'],
  ['waiting', '✨ Improve']
])('marks a %s stage as %s', (state, shown) => {
  const blocks = [stage('s1', { state, locked: true, progress: { stoppedAt: 1 } })]
  expect(upNextNotation({ blocks, header: { state: 'idle' }, now: { kind: 'idle' } })).toBe(shown)
})

it('does not name "current work" beside a stage the track stopped at', () => {
  const blocks = [stage('s1', { state: 'failed', locked: true })]
  const now = { kind: 'current-work' as const, agent: 'claude', label: 'Signing' }
  expect(upNextNotation({ blocks, header: { state: 'failed' }, now })).toBe('▲ ✨ Improve')
})

it('counts the queue behind a stop, never the stopped stage itself', () => {
  const blocks = [
    stage('s1', { state: 'waiting', locked: true, progress: { stoppedAt: 1 } }),
    stage('s2', { state: 'waiting' }),
    stage('s3')
  ]
  const summary = upNextSummary({
    blocks,
    header: { state: 'waiting', wake: 'Jordan Taylor' },
    now: { kind: 'stage', blockId: 's1' }
  })
  expect(summary.stages).toBe(2)
  expect(summary.perStage.map((entry) => entry.number)).toEqual(['2', '3'])
})

it.each(['completed', 'closed'] as const)(
  'reports a %s run as finished, with no queue and Done When counted as given',
  (state) => {
    const blocks = [
      stage('s1', { state: 'done', locked: true, progress: { durationMs: 60_000 } }),
      // A stage the run never reached: history, not work still to come.
      stage('s2')
    ]
    const summary = upNextSummary({
      blocks,
      header: { state },
      now: state === 'closed' ? { kind: 'closed', at: 1 } : { kind: 'completed', at: 1 },
      doneWhen: { met: 1, total: 2 }
    })
    expect(summary).toMatchObject({ stages: 0, executions: 0, prompts: 0, people: 0 })
    expect(summary.finished).toEqual({
      stages: 2,
      executions: 2,
      durationMs: 60_000,
      doneWhenMet: 1,
      doneWhenTotal: 2
    })
  }
)
