import { describe, expect, it, vi } from 'vitest'
import type {
  AgentSessionStatusEvent,
  AgentSessionStatusSummary
} from '../../shared/agent-session-wire'
import { followStructuredTurns, readStructuredLatestTurn } from './next-step-structured-turns'
import type { StructuredTurnFacts, TurnSignal } from './next-step-turn-signal'

function fakeHost(fullReply: string | null) {
  let emit: ((event: AgentSessionStatusEvent) => void) | null = null
  const summaries: AgentSessionStatusSummary[] = []
  const turn: StructuredTurnFacts = {
    running: false,
    hasTurn: true,
    awaitingStart: false,
    outcome: 'completed',
    lastSequence: 17
  }
  const replies: ((value: { summary: string } | null) => void)[] = []
  let deferReplies = false
  const host = {
    subscribeStatus: vi.fn((subscriber: { emit: (event: AgentSessionStatusEvent) => void }) => {
      emit = subscriber.emit
      subscriber.emit({ type: 'snapshot', sessions: summaries })
      return () => {
        emit = null
      }
    }),
    turnState: vi.fn(() => ({ ...turn })),
    outcomeSource: {
      context: vi.fn(() =>
        deferReplies
          ? new Promise<{ summary: string } | null>((resolve) => replies.push(resolve))
          : Promise.resolve(fullReply ? { summary: fullReply } : null)
      )
    },
    liveSessionStatusSummaries: () => summaries
  }
  return {
    host,
    summaries,
    turn,
    replies,
    deferReads: () => {
      deferReplies = true
    },
    send: (event: AgentSessionStatusEvent) => emit?.(event)
  }
}

const summary = (over: Partial<AgentSessionStatusSummary>): AgentSessionStatusSummary => ({
  sessionId: 'sess-1',
  workspaceId: 'repo::/w',
  agent: 'claude',
  status: 'idle',
  latestPrompt: 'Write the docs',
  lastAssistantMessage: 'Wrote the do…',
  updatedAt: 1,
  ...over
})

function follow(host: ReturnType<typeof fakeHost>['host']) {
  const signals: TurnSignal[] = []
  let hostListener: ((next: unknown) => void) | null = null
  const follower = followStructuredTurns({
    getHost: () => host as never,
    subscribeHostChanges: (listener) => {
      hostListener = listener as never
      return () => {}
    },
    onSignal: (signal) => {
      if (signal.kind !== 'ignore') {
        signals.push(signal)
      }
    }
  })
  return { signals, follower, swapHost: (next: unknown) => hostListener!(next) }
}

describe('followStructuredTurns', () => {
  it('fires on a live working → idle edge, with the full reply from the journal', async () => {
    const { host, summaries, send } = fakeHost('Wrote the docs in full.')
    summaries.push(summary({ status: 'working' }))
    const { signals, follower, swapHost } = follow(host)
    send({ type: 'status', session: summary({ agent: 'codex' }) })
    await vi.waitFor(() => expect(signals).toHaveLength(1))
    expect(signals[0]).toMatchObject({
      kind: 'finished',
      turn: {
        agent: 'codex',
        turnKey: expect.stringMatching(/@17$/),
        lastAssistantMessage: 'Wrote the docs in full.',
        conversation: { kind: 'structured', sessionId: 'sess-1' }
      }
    })
    send({ type: 'status', session: summary({ status: 'working' }) })
    expect(signals.at(-1)).toMatchObject({ kind: 'busy' })

    // A host swap re-subscribes; the old host's state is not a transition.
    swapHost(null)
    send({ type: 'status', session: summary({}) })
    expect(signals).toHaveLength(2)
    follower()
  })

  it('a submit flicker emits nothing, and the same reply is never signalled twice', async () => {
    const { host, summaries, turn, send } = fakeHost(null)
    summaries.push(summary({ status: 'working' }))
    const { signals } = follow(host)
    turn.awaitingStart = true
    send({ type: 'status', session: summary({}) })
    send({ type: 'status', session: summary({ status: 'working' }) })
    turn.awaitingStart = false
    expect(signals.filter((signal) => signal.kind !== 'busy')).toEqual([])

    send({ type: 'status', session: summary({}) })
    await vi.waitFor(() => expect(signals.filter((s) => s.kind === 'finished')).toHaveLength(1))
    // Working → idle again with no new journal entry: not a new reply.
    send({ type: 'status', session: summary({ status: 'working' }) })
    send({ type: 'status', session: summary({}) })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(signals.filter((s) => s.kind === 'finished')).toHaveLength(1)
  })

  it('a busy blip on the same turn holds the read until the session is idle again', async () => {
    const fake = fakeHost(null)
    fake.summaries.push(summary({ status: 'working' }))
    fake.deferReads()
    const { signals } = follow(fake.host)
    fake.send({ type: 'status', session: summary({}) })
    fake.send({ type: 'status', session: summary({ status: 'working' }) })
    fake.replies[0]!({ summary: 'the full reply' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(signals.map((signal) => signal.kind)).toEqual(['busy'])
    fake.send({ type: 'status', session: summary({}) })
    expect(signals.at(-1)).toMatchObject({
      kind: 'finished',
      turn: { lastAssistantMessage: 'the full reply' }
    })
    // One read, one signal: the settle did not re-issue it.
    expect(fake.host.outcomeSource.context).toHaveBeenCalledTimes(1)
    expect(signals.filter((signal) => signal.kind === 'finished')).toHaveLength(1)
  })

  it('a read still in flight across a same-turn blip lands once the session is idle', async () => {
    const fake = fakeHost(null)
    fake.summaries.push(summary({ status: 'working' }))
    fake.deferReads()
    const { signals } = follow(fake.host)
    fake.send({ type: 'status', session: summary({}) })
    fake.send({ type: 'status', session: summary({ status: 'working' }) })
    fake.send({ type: 'status', session: summary({}) })
    expect(fake.host.outcomeSource.context).toHaveBeenCalledTimes(1)
    fake.replies[0]!({ summary: 'the full reply' })
    await vi.waitFor(() => expect(signals.at(-1)).toMatchObject({ kind: 'finished' }))
  })

  it('a newer turn replaces the pending read', async () => {
    const fake = fakeHost(null)
    fake.summaries.push(summary({ status: 'working' }))
    fake.deferReads()
    const { signals } = follow(fake.host)
    fake.send({ type: 'status', session: summary({}) })
    fake.send({ type: 'status', session: summary({ status: 'working' }) })
    fake.turn.lastSequence = 30
    fake.send({ type: 'status', session: summary({}) })
    fake.replies[0]!({ summary: 'stale reply' })
    fake.replies[1]!({ summary: 'new reply' })
    await vi.waitFor(() => expect(signals.at(-1)).toMatchObject({ kind: 'finished' }))
    expect(signals.filter((signal) => signal.kind === 'finished')).toMatchObject([
      { turn: { lastAssistantMessage: 'new reply', turnKey: expect.stringMatching(/@30$/) } }
    ])
  })

  it('a read resolving after a snapshot dropped its session neither emits nor aborts', async () => {
    const fake = fakeHost(null)
    fake.summaries.push(summary({ status: 'working' }))
    fake.deferReads()
    const { signals, follower } = follow(fake.host)
    fake.send({ type: 'status', session: summary({}) })
    fake.send({ type: 'snapshot', sessions: [summary({ sessionId: 'sess-2' })] })
    expect(follower.tracked()).toEqual(['sess-2'])
    fake.replies[0]!({ summary: 'late' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(signals).toEqual([])
  })

  it('re-reads an unsettled turn on later updates and signals once it completes', async () => {
    const fake = fakeHost('full')
    fake.summaries.push(summary({ status: 'working' }))
    const { signals } = follow(fake.host)
    fake.turn.outcome = 'unknown'
    fake.send({ type: 'status', session: summary({}) })
    fake.send({ type: 'status', session: summary({ updatedAt: 2 }) })
    expect(signals).toEqual([])
    fake.turn.outcome = 'completed'
    fake.send({ type: 'status', session: summary({ updatedAt: 3 }) })
    await vi.waitFor(() => expect(signals).toMatchObject([{ kind: 'finished' }]))
  })

  it('forgets a session once the host no longer holds it', () => {
    const { host, summaries, send } = fakeHost(null)
    summaries.push(summary({ status: 'working' }), summary({ sessionId: 'sess-2' }))
    const { follower } = follow(host)
    expect(follower.tracked().sort()).toEqual(['sess-1', 'sess-2'])
    summaries.splice(1, 1)
    send({ type: 'status', session: summary({ status: 'working' }) })
    expect(follower.tracked()).toEqual(['sess-1'])
  })

  it('reads the newest finished chat turn for a manual request', async () => {
    const { host, summaries } = fakeHost(null)
    summaries.push(summary({}))
    expect(await readStructuredLatestTurn(host as never, 'repo::/w', 'sess-1')).toMatchObject({
      lastAssistantMessage: 'Wrote the do…',
      lastUserPrompt: 'Write the docs'
    })
    expect(await readStructuredLatestTurn(host as never, 'repo::/w', 'other')).toBeNull()
    expect(await readStructuredLatestTurn(null, 'repo::/w', 'sess-1')).toBeNull()
  })
})
