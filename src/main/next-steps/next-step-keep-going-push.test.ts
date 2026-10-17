import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NextStepDoneness, NextStepImprovementVerdict } from '../../shared/next-step-doneness'
import {
  NEXT_STEP_KEEP_GOING_DEFAULT_PUSH_PROMPT,
  type NextStepKeepGoingMode,
  type NextStepKeepGoingStopReason
} from '../../shared/next-step-keep-going'
import {
  conversation,
  harness as openHarness,
  KEY,
  MARKER,
  safe,
  withKeepGoingDirectory
} from './next-step-keep-going-harness'
import type { NextStepKeepGoingJudges } from './next-step-keep-going-judge'
import { NextStepKeepGoingStore } from './next-step-keep-going-store'

const directory = withKeepGoingDirectory()

// Why: every write must land before the directory is removed (hooks run in reverse order).
const opened: ReturnType<typeof openHarness>[] = []
const harness = (...args: Parameters<typeof openHarness>) => {
  const h = openHarness(...args)
  opened.push(h)
  return h
}
afterEach(async () => {
  await Promise.all(opened.splice(0).flatMap((h) => [h.store.flush(), h.sets.flush()]))
})

const PUSH = { mode: 'push-for-better' as const }

function pushing(options: Parameters<typeof harness>[0] = {}, run: { pushPrompt?: string } = {}) {
  const h = harness(options)
  h.service.currentTurns.set(KEY, {
    turnKey: 't0',
    order: 0,
    turn: { conversation, turnKey: 't0', lastAssistantMessage: 'Headline v1' }
  })
  h.keepGoing.setKeepGoing(conversation, true, 3, 'person-stopped', { ...PUSH, ...run })
  return h
}

/** The round the host sent finishes as the next turn, with `reply`. */
function finishRound(h: ReturnType<typeof harness>, turnKey: string, reply = 'Done.') {
  h.deliver()
  h.finish(turnKey, h.lastSent(), { reply })
}

const reading = (over: Partial<NextStepDoneness> = {}): NextStepDoneness => ({
  resolved: 0.5,
  remainingWork: 0.5,
  roomToImprove: 0.5,
  verified: 0.5,
  unsure: false,
  turnKey: 't1',
  at: 1,
  ...over
})
const DONE = reading({ resolved: 0.92, remainingWork: 0.1, roomToImprove: 0.1, verified: 0.9 })

describe('Push for better', () => {
  it('sends the exact push prompt with the marker and provenance, without any AI set', async () => {
    const h = pushing()
    await h.settle()
    expect(h.sets.list()).toEqual([])
    expect(h.queue.entries).toHaveLength(1)
    const [entry] = h.queue.entries
    expect(entry!.text.replace(MARKER, '')).toBe(NEXT_STEP_KEEP_GOING_DEFAULT_PUSH_PROMPT)
    expect(entry!.text).toMatch(/^\[Keep going 1\/3 · kg-/)
    expect(entry!.origin).toMatchObject({ kind: 'keep-going', round: 1 })
    expect(h.state()).toMatchObject({ enabled: true, mode: 'push-for-better', roundsUsed: 1 })
    expect(() => h.keepGoing.assertDelivery(conversation, entry!)).not.toThrow()
  })

  it('pushes on each finished round until the cap, with the person’s own prompt, even a hard-stop word', async () => {
    const h = pushing({}, { pushPrompt: '  Deploy-ready? Make the headline sharper.  ' })
    await h.settle()
    finishRound(h, 't1')
    await h.settle()
    finishRound(h, 't2')
    await h.settle()
    expect(h.sent().map((text) => text.replace(MARKER, ''))).toEqual([
      'Deploy-ready? Make the headline sharper.',
      'Deploy-ready? Make the headline sharper.',
      'Deploy-ready? Make the headline sharper.'
    ])
    finishRound(h, 't3')
    h.expectStopped('cap-reached')
  })

  it('caps the prompt at 2,000 characters and keeps it for the conversation', async () => {
    const h = pushing({}, { pushPrompt: 'x'.repeat(2500) })
    await h.settle()
    expect(h.lastSent().replace(MARKER, '')).toHaveLength(2000)
    h.keepGoing.setKeepGoing(conversation, false)
    expect(h.keepGoing.setKeepGoing(conversation, true).pushPrompt).toHaveLength(2000)
  })

  it('switches mode on a running conversation without resetting its rounds', async () => {
    const h = harness()
    h.observe('t0')
    h.keepGoing.setKeepGoing(conversation, true, 5)
    h.offer('t1', [safe('s1')])
    await h.settle()
    expect(h.keepGoing.setKeepGoing(conversation, true, 5, 'person-stopped', PUSH)).toMatchObject({
      mode: 'push-for-better',
      roundsUsed: 1
    })
  })

  it.each<[string, (h: ReturnType<typeof harness>) => void, NextStepKeepGoingStopReason]>([
    [
      'the person typed',
      (h) => h.keepGoing.setKeepGoing(conversation, false, undefined, 'person-typing'),
      'person-typing'
    ],
    ['the person sent their own message', (h) => h.finish('t1', 'My own words'), 'person-message'],
    [
      'the agent asks a question',
      (h) => h.keepGoing.onAttention(conversation, 'agent-waiting'),
      'agent-waiting'
    ],
    [
      'the turn failed',
      (h) => h.keepGoing.onTurnSignal({ kind: 'busy', conversation }, 'turn-failed'),
      'turn-failed'
    ],
    ['the pane closed', (h) => h.keepGoing.onConversationClosed(conversation), 'pane-closed']
  ])('stops, withdrawing its round, when %s', async (_case, act, reason) => {
    const h = pushing()
    await h.settle()
    act(h)
    h.expectStopped(reason)
    expect(h.sent()).toEqual([])
  })

  it('stops on a queued message of the person’s before pushing', async () => {
    const h = harness()
    h.observe('t0')
    h.queue.entries.push({ id: 'mine', text: 'Mine', createdAt: 1, state: 'queued' })
    h.keepGoing.setKeepGoing(conversation, true, 3, 'person-stopped', PUSH)
    await h.settle()
    h.expectStopped('person-message')
    expect(h.sent()).toEqual(['Mine'])
  })

  it('is off after a restart, keeps its mode and prompt, and a left-over push is withdrawn', async () => {
    const h = pushing({}, { pushPrompt: 'Sharper.' })
    await h.settle()
    await h.store.flush()
    const reloaded = new NextStepKeepGoingStore({ directory: directory() })
    reloaded.load()
    const after = harness({ store: reloaded })
    after.queue.entries.push(h.queue.entries[0]!)
    expect(after.state()).toMatchObject({
      enabled: false,
      stopReason: 'restarted',
      mode: 'push-for-better',
      pushPrompt: 'Sharper.'
    })
    after.keepGoing.withdrawStaleEntries()
    expect(after.queue.entries[0]!.state).toBe('failed')
  })
})

describe('JEV stops', () => {
  const judged = (judges: NextStepKeepGoingJudges, mode: NextStepKeepGoingMode) => {
    const h = mode === 'push-for-better' ? pushing({ judges }) : harness({ judges })
    if (mode === 'next-step') {
      h.observe('t0')
      h.keepGoing.setKeepGoing(conversation, true, 3)
      h.offer('t0b', [safe('s1')])
    }
    return h
  }

  it.each<NextStepKeepGoingMode>(['next-step', 'push-for-better'])(
    'stops as done on a clear reading (%s), with the percentage',
    async (mode) => {
      const assessDoneness = vi.fn(async () => DONE)
      const h = judged({ assessDoneness }, mode)
      await h.settle()
      finishRound(h, 't1', 'Final copy')
      await h.settle()
      expect(h.state()).toMatchObject({ enabled: false, stopReason: 'done', stopPercent: 92 })
      expect(assessDoneness).toHaveBeenCalledWith({
        conversation,
        turnKey: 't1',
        reply: 'Final copy'
      })
      expect(h.sent()).toHaveLength(1)
    }
  )

  it.each<[string, NextStepDoneness | null | Error | undefined]>([
    // Each deciding reading is checked on its own; the overall flag is display only.
    ['unsure', { ...DONE, remainingWork: 0.5, roomToImprove: 0.5, unsure: true }],
    ['null', null],
    ['for another turn', { ...DONE, turnKey: 'tX' }],
    ['failed', new Error('JEV down')],
    ['missing', undefined]
  ])('never stops on a reading that is %s, in either mode', async (_case, answer) => {
    for (const mode of ['next-step', 'push-for-better'] as const) {
      const assessDoneness =
        answer === undefined
          ? undefined
          : vi.fn(async () => {
              if (answer instanceof Error) {
                throw answer
              }
              return answer
            })
      const h = judged(assessDoneness ? { assessDoneness } : {}, mode)
      await h.settle()
      finishRound(h, 't1')
      if (mode === 'next-step') {
        h.offer('t1', [safe('s2')])
      }
      await h.settle()
      expect(h.state()).toMatchObject({ enabled: true, roundsUsed: 2 })
    }
  })

  it('holds the next round until the reading answers', async () => {
    let answer: (value: NextStepDoneness | null) => void = () => {}
    const assessDoneness = () => new Promise<NextStepDoneness | null>((r) => (answer = r))
    const h = judged({ assessDoneness }, 'next-step')
    await h.settle()
    finishRound(h, 't1')
    h.offer('t1', [safe('s2')])
    await h.settle()
    expect(h.sent()).toHaveLength(1)
    answer(null)
    await h.settle()
    expect(h.sent()).toHaveLength(2)
  })

  it.each<[string, NextStepKeepGoingJudges]>([
    [
      'the round clearly did not help',
      { judgeImprovement: async () => ({ improved: 0.1, unsure: false }) }
    ],
    [
      'there is clearly no room left',
      { assessDoneness: async () => reading({ roomToImprove: 0.1 }) }
    ]
  ])('stops Push for better when %s', async (_case, judges) => {
    const h = judged(judges, 'push-for-better')
    await h.settle()
    finishRound(h, 't1')
    await h.settle()
    h.expectStopped('no-more-improvement')
    expect(h.sent()).toHaveLength(1)
  })

  it.each<[string, NextStepImprovementVerdict | null]>([
    ['unsure', { improved: 0.1, unsure: true }],
    ['null', null],
    ['an improvement', { improved: 0.9, unsure: false }]
  ])(
    'keeps pushing on a verdict that is %s, comparing this run’s last two replies',
    async (_case, verdict) => {
      const judgeImprovement = vi.fn(async () => verdict)
      const h = judged({ judgeImprovement }, 'push-for-better')
      await h.settle()
      finishRound(h, 't1', 'Headline v2')
      await h.settle()
      expect(judgeImprovement).toHaveBeenCalledWith(
        expect.objectContaining({ turnKey: 't1', previous: 'Headline v1', latest: 'Headline v2' })
      )
      expect(h.state()).toMatchObject({ enabled: true, roundsUsed: 2 })
    }
  )

  it('keeps pushing on a clear done reading while room to improve is not clearly gone', async () => {
    const assessDoneness = vi.fn(async () => ({ ...DONE, roomToImprove: 0.5, unsure: true }))
    const h = judged({ assessDoneness }, 'push-for-better')
    await h.settle()
    finishRound(h, 't1')
    await h.settle()
    expect(h.state()).toMatchObject({ enabled: true, roundsUsed: 2 })
  })

  it('never compares an empty reply, and judges each round on its own reply', async () => {
    const assessDoneness = vi.fn(async () => null)
    const judgeImprovement = vi.fn(async () => ({ improved: 0.1, unsure: false }))
    const h = judged({ assessDoneness, judgeImprovement }, 'push-for-better')
    await h.settle()
    finishRound(h, 't1', '')
    await h.settle()
    expect(assessDoneness).toHaveBeenLastCalledWith(expect.objectContaining({ reply: '' }))
    finishRound(h, 't2', 'Headline v3')
    await h.settle()
    expect(judgeImprovement).not.toHaveBeenCalled()
    expect(h.state()).toMatchObject({ enabled: true, roundsUsed: 3 })
  })

  it('never asks whether a next-step round improved; only doneness stops it', async () => {
    const judgeImprovement = vi.fn(async () => ({ improved: 0, unsure: false }))
    const h = judged({ judgeImprovement }, 'next-step')
    await h.settle()
    finishRound(h, 't1')
    h.offer('t1', [safe('s2')])
    await h.settle()
    expect(judgeImprovement).not.toHaveBeenCalled()
    expect(h.state()).toMatchObject({ enabled: true, roundsUsed: 2 })
  })
})
