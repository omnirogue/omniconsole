import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ConversationSource } from '../../shared/conversation-source'
import type { NextStepKeepGoingStopReason } from '../../shared/next-step-keep-going'
import type { NextStepSuggestion } from '../../shared/next-step-suggestions'
import type { ConversationCapacityRecovery } from '../../shared/prompt-queue-types'
import { decideNextSteps } from './next-step-decisions'
import {
  conversation,
  harness,
  KEY,
  MARKER,
  risky,
  safe,
  withKeepGoingDirectory
} from './next-step-keep-going-harness'
import {
  NEXT_STEP_KEEP_GOING_FILE,
  NEXT_STEP_KEEP_GOING_MAX_ENTRIES,
  NextStepKeepGoingStore
} from './next-step-keep-going-store'

const directory = withKeepGoingDirectory()

describe('turning keep going on and off', () => {
  it('defaults to the setting, keeps 1–25 rounds, and never resets a running count', async () => {
    const h = harness({ keepGoingMaxRounds: 5 })
    h.observe('t0')
    expect(h.keepGoing.setKeepGoing(conversation, true)).toMatchObject({
      enabled: true,
      maxRounds: 5,
      roundsUsed: 0
    })
    h.offer('t1', [safe('s1')])
    await h.settle()
    expect(h.state().roundsUsed).toBe(1)
    expect(h.keepGoing.setKeepGoing(conversation, true, 9)).toMatchObject({
      roundsUsed: 1,
      maxRounds: 5
    })
    h.keepGoing.setKeepGoing(conversation, false)
    h.expectStopped('person-stopped')
    expect(h.keepGoing.setKeepGoing(conversation, true, 42)).toMatchObject({
      maxRounds: 5,
      roundsUsed: 0
    })
    expect(h.keepGoing.setKeepGoing(conversation, false, undefined, 'person-acted')).toMatchObject({
      stopReason: 'person-acted'
    })
    expect(harness().keepGoing.setKeepGoing(conversation, true, 25).maxRounds).toBe(25)
  })

  it('is off after a restart, and a live controller on the reloaded state runs nothing', async () => {
    const h = harness()
    h.keepGoing.setKeepGoing(conversation, true, 4)
    await h.store.flush()
    const reloaded = new NextStepKeepGoingStore({ directory: directory(), now: () => 99 })
    reloaded.load()
    const after = harness({ store: reloaded })
    expect(after.state()).toMatchObject({
      enabled: false,
      maxRounds: 4,
      stopReason: 'restarted',
      stoppedAt: 99
    })
    after.offer('t1', [safe('s1')])
    await after.settle()
    after.keepGoing.sweep()
    expect(after.sent()).toEqual([])
    await reloaded.flush()
    const saved = JSON.parse(readFileSync(join(directory(), NEXT_STEP_KEEP_GOING_FILE), 'utf8'))
    expect(saved.entries[0].enabled).toBe(false)
  })

  it('withdraws, and logs, an automatic entry an earlier run left queued', async () => {
    const h = harness()
    h.queue.entries.push({
      id: 'next-step:old:s1',
      text: '[Keep going 1/3 · kg-abcdef] Please do step s1.',
      createdAt: 1,
      state: 'queued',
      origin: { kind: 'keep-going', runToken: 'gone00', round: 1 }
    })
    h.queue.entries.push({ id: 'mine', text: 'My own message', createdAt: 2, state: 'queued' })
    h.keepGoing.withdrawStaleEntries()
    expect(h.queue.entries.map((entry) => entry.state)).toEqual(['failed', 'queued'])
    await h.settle()
    expect(h.log()).toContainEqual(
      expect.objectContaining({ reason: 'restarted', removedQueuedEntry: true })
    )
  })

  it('keeps the ad-pause choice and the last allowed pause across a restart, dropping junk', () => {
    const lastAdPause = { at: 5, round: 2, title: 'Pause ad set 4' }
    const saved = { conversation, enabled: true, maxRounds: 4, roundsUsed: 2, startedAt: 1 }
    writeFileSync(
      join(directory(), NEXT_STEP_KEEP_GOING_FILE),
      JSON.stringify({
        entries: [
          { ...saved, adPauses: 'ask-first', lastAdPause, stopReason: 'needs-you-ad-pause' },
          {
            ...saved,
            conversation: { ...conversation, paneKey: 'tab-2:leaf' },
            adPauses: 'sometimes',
            lastAdPause: { round: 'two' }
          }
        ]
      })
    )
    const store = new NextStepKeepGoingStore({ directory: directory() })
    store.load()
    const [first, second] = store.list()
    expect(first).toMatchObject({ enabled: false, adPauses: 'ask-first', lastAdPause })
    expect(second).not.toHaveProperty('adPauses')
    expect(second).not.toHaveProperty('lastAdPause')
  })

  it('drops unreadable saved rows', () => {
    writeFileSync(
      join(directory(), NEXT_STEP_KEEP_GOING_FILE),
      JSON.stringify({ entries: [{ conversation, enabled: true, maxRounds: 99 }, 'x'] })
    )
    const store = new NextStepKeepGoingStore({ directory: directory() })
    store.load()
    expect(store.list()).toEqual([])
  })

  it('stops a running conversation pushed out of the bounded file, and records it', async () => {
    const h = harness()
    h.keepGoing.setKeepGoing(conversation, true)
    for (let at = 0; at < NEXT_STEP_KEEP_GOING_MAX_ENTRIES; at++) {
      h.keepGoing.setKeepGoing({ ...conversation, paneKey: `tab-${at}:leaf` }, true)
    }
    expect(h.state()).toBeUndefined()
    await h.settle()
    expect(h.log()).toContainEqual(
      expect.objectContaining({ type: 'keep-going-stop', reason: 'evicted' })
    )
  })
})

describe('a round', () => {
  it('runs only the first suggestion, marked, with its provenance, through decide', async () => {
    const h = harness()
    h.keepGoing.setKeepGoing(conversation, true)
    const set = h.offer('t1', [safe('s1'), safe('s2')])
    await h.settle()
    expect(h.queue.entries).toEqual([
      expect.objectContaining({
        id: `next-step:${set.id}:s1`,
        origin: { kind: 'keep-going', runToken: expect.any(String), round: 1 }
      })
    ])
    expect(h.lastSent()).toMatch(MARKER)
    expect(h.lastSent().replace(MARKER, '')).toBe('Please do step s1.')
    expect(h.sets.get(set.id)?.status).toBe('accepted')
    expect(h.state()).toMatchObject({ enabled: true, roundsUsed: 1 })
    expect(h.log()[0]!.decision).toEqual({ action: 'run', suggestionIds: ['s1'], auto: true })
  })

  it('re-checks its own conditions inside decide, after its last await, before anything is claimed', async () => {
    const h = harness()
    const set = h.offer('t1', [safe('s1')])
    const recheck = vi.fn(() => 'Refused at the last moment.')
    await expect(
      decideNextSteps(h.service, set.id, { action: 'run', suggestionIds: ['s1'], auto: true }, 1, {
        prefix: '[Keep going 1/3 · kg-000001] ',
        origin: { kind: 'keep-going', runToken: 'run', round: 1 },
        recheck
      })
    ).rejects.toThrow('Refused at the last moment.')
    expect(recheck).toHaveBeenCalledTimes(1)
    expect(h.queue.entries).toEqual([])
    expect(h.sets.get(set.id)?.status).toBe('pending')
  })

  it('never queues a round when a stop condition appears while decide awaits the turn', async () => {
    const h = harness({
      decide: (...args) => {
        const decided = decideNextSteps(...args)
        h.flags.attention = 'agent-waiting'
        return decided
      }
    })
    h.keepGoing.setKeepGoing(conversation, true)
    h.offer('t1', [safe('s1')])
    await h.settle()
    expect(h.queue.entries).toEqual([])
    h.expectStopped('agent-waiting')
  })

  it('never runs a start set', async () => {
    const h = harness()
    h.keepGoing.setKeepGoing(conversation, true)
    h.offer('t1', [safe('s1')], 'start')
    await h.settle()
    h.keepGoing.sweep()
    expect(h.sent()).toEqual([])
  })

  it('runs the reply’s own first step before the AI’s, with its prompt behind the marker', async () => {
    const h = harness()
    h.keepGoing.setKeepGoing(conversation, true)
    const own = 'Please go ahead with this next step you suggested: Put the hourly auto-sync back'
    h.offer('t1', [safe('a1')])
    h.offer('t1', [safe('s1', { title: 'Put the hourly auto-sync back', prompt: own })], 'parsed')
    await h.settle()
    expect(h.sent()).toHaveLength(1)
    expect(h.lastSent()).toMatch(MARKER)
    expect(h.lastSent().replace(MARKER, '')).toBe(own)
    expect(h.queue.entries[0]!.id).toBe('next-step:set-2:s1')
  })

  it('follows the session’s plan round after round and never stops itself', async () => {
    const h = harness()
    const reply = (step: string) => `Done.\n\nNext steps:\n1. ${step}\n2. Update the changelog`
    const turn = (turnKey: string, step: string, order: number, lastUserPrompt?: string) => ({
      conversation,
      turnKey,
      lastAssistantMessage: reply(step),
      order,
      completedAt: 10_000 + order,
      ...(lastUserPrompt ? { lastUserPrompt } : {})
    })
    h.keepGoing.setKeepGoing(conversation, true, 3)
    h.observe('t1', 1)
    // The host reads the reply's own steps; that parsed set is what Keep going runs.
    h.service.onFinishedTurn(turn('t1', 'Put the hourly auto-sync back', 1))
    await h.settle()
    expect(h.lastSent()).toMatch(/^\[Keep going 1\/3 · kg-[0-9a-f]{6}\] /)
    expect(h.lastSent()).toContain('you suggested: Put the hourly auto-sync back')
    h.deliver()
    const sent = h.lastSent()
    h.finish('t2', sent, { order: 2, completedAt: 20_000 })
    h.service.onFinishedTurn(turn('t2', 'Turn off the job and archive those objectives', 2, sent))
    await h.settle()
    expect(h.state()).toMatchObject({ enabled: true, roundsUsed: 2 })
    expect(h.sent()).toHaveLength(2)
    expect(h.lastSent()).toMatch(/^\[Keep going 2\/3 · kg-[0-9a-f]{6}\] /)
    expect(h.lastSent()).toContain('you suggested: Turn off the job and archive those objectives')
    expect(h.service.deps.generate).not.toHaveBeenCalled()
  })

  it('runs one round per turn, even when the turn gets a second AI set', async () => {
    const h = harness()
    await h.firstRound()
    h.offer('t1', [safe('again')])
    await h.settle()
    h.keepGoing.sweep()
    expect(h.sent()).toHaveLength(1)
  })

  it('goes round by round, each with its own marker, until the cap', async () => {
    const h = harness()
    await h.firstRound(2)
    h.finish('t2', h.lastSent())
    h.offer('t2', [safe('s2')])
    await h.settle()
    expect(h.lastSent()).toMatch(/^\[Keep going 2\/2 · kg-/)
    h.deliver()
    h.finish('t3', h.lastSent())
    h.expectStopped('cap-reached')
    expect(h.state().roundsUsed).toBe(2)
    await h.settle()
    expect(h.log().at(-1)).toMatchObject({ type: 'keep-going-stop', reason: 'cap-reached' })
  })
})

describe('telling our rounds from the person', () => {
  it('continues on a truncated preview of exactly what was sent', async () => {
    const h = harness()
    await h.firstRound()
    h.finish('t2', h.lastSent().slice(0, 40))
    expect(h.state().enabled).toBe(true)
  })

  it.each([
    ['the person typed their own message', () => 'Actually, explain the parser first.'],
    ['the person retyped the suggestion itself', () => 'Please do step s1.'],
    [
      'a pasted marker in front of other words',
      (sent: string) => sent.replace(/\] .*/, '] Delete it.')
    ],
    ['a marker cut short', (sent: string) => sent.slice(0, 10)],
    ['no readable prompt', () => undefined]
  ])('stops when %s', async (_case, prompt) => {
    const h = harness()
    await h.firstRound()
    h.finish('t2', prompt(h.lastSent()))
    h.expectStopped('person-message')
  })

  it('stops when a turn finishes before our delivery, and withdraws the round', async () => {
    const h = harness()
    h.keepGoing.setKeepGoing(conversation, true)
    h.offer('t1', [safe('s1')])
    await h.settle()
    h.finish('t2', h.lastSent())
    h.expectStopped('person-message')
    expect(h.queue.entries[0]!.state).toBe('failed')
  })

  it('stops when the turn finished before the delivery time', async () => {
    const h = harness()
    await h.firstRound()
    h.finish('t2', h.lastSent(), { completedAt: 1 })
    h.expectStopped('person-message')
  })

  it('stops on any finished turn while no round is outstanding', () => {
    const h = harness()
    h.observe('t0')
    h.keepGoing.setKeepGoing(conversation, true)
    h.finish('t9', 'Anything')
    h.expectStopped('person-message')
  })

  it('ignores a re-report of the turn it last accounted for, and a replayed older turn', async () => {
    const h = harness()
    await h.firstRound()
    h.finish('t2', h.lastSent())
    h.finish('t2', h.lastSent())
    h.finish('t-old', 'Anything', { order: 1 })
    expect(h.state().enabled).toBe(true)
  })

  it('stops, without completing the round, on a turn whose order is unknown', async () => {
    const h = harness()
    await h.firstRound()
    h.finish('t-replay', h.lastSent(), { order: null })
    h.expectStopped('turn-unknown')
    expect(h.state().roundsUsed).toBe(1)
    h.offer('t-replay', [safe('s9')])
    await h.settle()
    expect(h.sent()).toHaveLength(1)
  })

  it('stops when the host does not know the current turn', async () => {
    const h = harness()
    h.keepGoing.setKeepGoing(conversation, true)
    await h.settle()
    h.expectStopped('turn-unknown')
    const later = harness()
    await later.firstRound()
    later.service.currentTurns.delete(KEY)
    later.keepGoing.sweep()
    later.expectStopped('turn-unknown')
  })
})

describe('the delivery-time check', () => {
  it('passes the outstanding round and refuses anything else', async () => {
    const h = harness()
    h.keepGoing.setKeepGoing(conversation, true)
    h.offer('t1', [safe('s1')])
    await h.settle()
    const entry = h.queue.entries[0]!
    expect(() => h.keepGoing.assertDelivery(conversation, entry)).not.toThrow()
    const forged = { ...entry, origin: { ...entry.origin!, runToken: 'forged' } }
    expect(() => h.keepGoing.assertDelivery(conversation, forged)).toThrow(/round-refused/)
    h.expectStopped('round-refused')
    expect(() => h.keepGoing.assertDelivery(conversation, entry)).toThrow(/off/)
  })

  it('refuses, and stops, when the person queued something meanwhile', async () => {
    const h = harness()
    h.keepGoing.setKeepGoing(conversation, true)
    h.offer('t1', [safe('s1')])
    await h.settle()
    h.queue.entries.push({ id: 'mine', text: 'Mine', createdAt: 2, state: 'queued' })
    expect(() => h.keepGoing.assertDelivery(conversation, h.queue.entries[0]!)).toThrow(
      /person-message/
    )
    h.expectStopped('person-message')
    expect(h.queue.entries[0]!.state).toBe('failed')
  })
})

describe('what stops it', () => {
  type Case = {
    name: string
    suggestions: NextStepSuggestion[]
    reason: NextStepKeepGoingStopReason
  }
  it.each<Case>([
    {
      name: 'an empty first prompt',
      suggestions: [safe('e', { prompt: '  ' }), safe('s2')],
      reason: 'no-safe-suggestion'
    },
    {
      name: 'a question first',
      suggestions: [safe('q', { kind: 'ask' }), safe('s')],
      reason: 'needs-you-question'
    },
    { name: 'no steps at all', suggestions: [], reason: 'no-safe-suggestion' }
  ])('stops on $name, never skipping ahead', async ({ suggestions, reason }) => {
    const h = harness()
    h.keepGoing.setKeepGoing(conversation, true)
    h.offer('t1', suggestions)
    await h.settle()
    expect(h.sent()).toEqual([])
    h.expectStopped(reason)
  })

  it('stops, without running, while the queue holds something it did not put there', async () => {
    const h = harness()
    h.keepGoing.setKeepGoing(conversation, true)
    h.queue.entries.push({ id: 'mine', text: 'My own message', createdAt: 1, state: 'queued' })
    h.offer('t1', [safe('s1')])
    await h.settle()
    expect(h.sent()).toEqual(['My own message'])
    h.expectStopped('person-message')
  })

  type LiveCase = {
    name: string
    arrange: (h: ReturnType<typeof harness>) => void
    reason: NextStepKeepGoingStopReason
  }
  it.each<LiveCase>([
    {
      name: 'the person queues a message',
      arrange: (h) =>
        h.queue.entries.push({ id: 'p', text: 'Mine', createdAt: 2, state: 'queued' }),
      reason: 'person-message'
    },
    {
      name: 'capacity recovery starts',
      arrange: (h) => {
        h.queue.recovery = { phase: 'waiting-capacity' } as ConversationCapacityRecovery
      },
      reason: 'capacity-recovery'
    },
    {
      name: 'suggestions are turned off',
      arrange: (h) => (h.flags.enabled = false),
      reason: 'setting-off'
    },
    {
      name: 'a plan binds the conversation',
      arrange: (h) => (h.flags.chainBound = true),
      reason: 'chain-bound'
    },
    {
      name: 'a question or permission prompt opens',
      arrange: (h) => (h.flags.attention = 'agent-waiting'),
      reason: 'agent-waiting'
    },
    {
      name: 'the turn fails mid-work',
      arrange: (h) => (h.flags.attention = 'turn-failed'),
      reason: 'turn-failed'
    },
    {
      name: 'the conversation closes',
      arrange: (h) => (h.flags.open = false),
      reason: 'pane-closed'
    }
  ])('stops on the live sweep when $name, mid-round', async ({ arrange, reason }) => {
    const h = harness()
    await h.firstRound()
    arrange(h)
    h.keepGoing.sweep()
    h.expectStopped(reason)
  })

  it('leaves its own queued round alone on the sweep', async () => {
    const h = harness()
    h.keepGoing.setKeepGoing(conversation, true)
    h.offer('t1', [safe('s1')])
    await h.settle()
    h.keepGoing.sweep()
    expect(h.state().enabled).toBe(true)
    expect(h.queue.entries[0]!.state).toBe('queued')
  })

  it('stops everywhere, withdrawing its round, when the sweep cannot run', async () => {
    const h = harness()
    h.keepGoing.setKeepGoing(conversation, true)
    h.offer('t1', [safe('s1')])
    await h.settle()
    h.keepGoing.stopAll('Keep going could not check this conversation, so it stopped.')
    h.expectStopped('round-refused')
    expect(h.queue.entries[0]!.state).toBe('failed')
  })

  it('stops when the AI set failed', async () => {
    const h = harness()
    h.keepGoing.setKeepGoing(conversation, true)
    h.observe('t1')
    h.sets.upsert({
      ...h.service.newSet({ conversation, turnKey: 't1' }, 'ai', 'failed', []),
      error: 'The suggester timed out.'
    })
    await h.settle()
    expect(h.state()).toMatchObject({
      stopReason: 'set-failed',
      stopDetail: 'The suggester timed out.'
    })
  })

  it('stops, with the refusal, when the turn was already answered', async () => {
    const h = harness()
    h.keepGoing.setKeepGoing(conversation, true)
    h.offer('t1', [safe('p1')], 'parsed', 'accepted')
    h.offer('t1', [safe('s1')])
    await h.settle()
    expect(h.sent()).toEqual([])
    expect(h.state()).toMatchObject({
      stopReason: 'round-refused',
      stopDetail: 'This turn was already answered.'
    })
  })

  it('stops, with the refusal, when decide refuses the round, sync or async', async () => {
    for (const decide of [
      () => Promise.reject(new Error('These suggestions are for an earlier turn.')),
      () => {
        throw new Error('These suggestions are for an earlier turn.')
      }
    ]) {
      const h = harness({ decide })
      h.keepGoing.setKeepGoing(conversation, true)
      h.offer('t1', [safe('s1')])
      await h.settle()
      expect(h.state()).toMatchObject({
        stopReason: 'round-refused',
        stopDetail: 'These suggestions are for an earlier turn.',
        roundsUsed: 0
      })
    }
  })

  it('does not commit, and withdraws, a round that went stale after it was queued', async () => {
    const h = harness({
      decide: (...args) =>
        decideNextSteps(...args).then((result) => {
          h.flags.attention = 'agent-waiting'
          return result
        })
    })
    h.keepGoing.setKeepGoing(conversation, true)
    h.offer('t1', [safe('s1')])
    await h.settle()
    expect(h.state()).toMatchObject({ stopReason: 'agent-waiting', roundsUsed: 0 })
    expect(h.queue.entries[0]!.state).toBe('failed')
  })

  it('counts nothing and stops when the queue refuses the step', async () => {
    const h = harness()
    h.flags.refuse = 'The queue is full.'
    h.keepGoing.setKeepGoing(conversation, true)
    h.offer('t1', [safe('s1')])
    await h.settle()
    expect(h.state()).toMatchObject({
      roundsUsed: 0,
      stopReason: 'not-queued',
      stopDetail: 'The queue is full.'
    })
  })

  it('stops when the person answers a set themselves', () => {
    const h = harness()
    h.keepGoing.setKeepGoing(conversation, true)
    h.keepGoing.onPersonDecided(h.offer('t1', [risky('r1')]))
    h.expectStopped('person-decided')
  })

  it('stops on a failed or skipped turn, and on a report that needs the person', async () => {
    const skipped = harness()
    await skipped.firstRound()
    skipped.keepGoing.onTurnSignal({
      kind: 'skip',
      conversation,
      turnKey: 't2',
      order: 99,
      reason: 'The turn was interrupted before it finished.'
    })
    expect(skipped.state()).toMatchObject({
      stopReason: 'turn-skipped',
      stopDetail: 'The turn was interrupted before it finished.'
    })
    const failed = harness()
    await failed.firstRound()
    failed.keepGoing.onTurnSignal({ kind: 'busy', conversation }, 'turn-failed')
    failed.expectStopped('turn-failed')
    const waiting = harness()
    await waiting.firstRound()
    waiting.keepGoing.onTurnSignal(
      {
        kind: 'finished',
        turn: {
          conversation,
          turnKey: 't2',
          order: 99,
          lastAssistantMessage: 'x',
          lastUserPrompt: waiting.lastSent()
        }
      },
      'agent-waiting'
    )
    waiting.expectStopped('agent-waiting')
  })

  it('matches a closed pane to terminal conversations only; a chat is closed by identity', () => {
    const chat: ConversationSource = { ...conversation, kind: 'structured', sessionId: 's1' }
    const h = harness()
    h.keepGoing.setKeepGoing(chat, true)
    h.keepGoing.onPaneClosed(chat.paneKey)
    expect(h.keepGoing.list({ conversation: chat })[0]!.enabled).toBe(true)
    h.keepGoing.onConversationClosed(chat)
    expect(h.keepGoing.list({ conversation: chat })[0]!.stopReason).toBe('pane-closed')
    h.keepGoing.setKeepGoing(conversation, true)
    h.keepGoing.onPaneClosed(conversation.paneKey)
    h.expectStopped('pane-closed')
  })

  it('takes an in-flight round back out of the queue when stopped, and never counts it', async () => {
    const h = harness({
      decide: (...args) => {
        const decided = decideNextSteps(...args)
        return new Promise((resolve) => setTimeout(() => resolve(decided), 30))
      }
    })
    h.keepGoing.setKeepGoing(conversation, true)
    h.offer('t1', [safe('s1')])
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(h.sent()).toHaveLength(1)
    h.keepGoing.setKeepGoing(conversation, false)
    expect(h.sent()).toEqual([])
    await h.settle()
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(h.state()).toMatchObject({ enabled: false, roundsUsed: 0, stopReason: 'person-stopped' })
    expect(h.log().find((line) => line.type === 'keep-going-stop')).toMatchObject({
      reason: 'person-stopped',
      removedQueuedEntry: true
    })
  })

  it('does nothing for a conversation that never opted in', async () => {
    const h = harness()
    h.offer('t1', [safe('s1')])
    await h.settle()
    h.keepGoing.sweep()
    h.keepGoing.onPaneClosed(conversation.paneKey)
    expect(h.sent()).toEqual([])
    expect(h.state()).toBeUndefined()
  })
})

describe('another session acting on it at the person’s request', () => {
  it('stops with the person’s own reason (every client reads it), naming the acting session', () => {
    const h = harness()
    h.keepGoing.setKeepGoing(conversation, true)
    const detail = 'Manager continued this conversation at your request.'
    expect(h.keepGoing.onSessionManaged(conversation, detail, 'person-message')).toBe(true)
    expect(h.state()).toMatchObject({
      enabled: false,
      stopReason: 'person-message',
      stopDetail: detail
    })
    // Already off: nothing to stop.
    expect(h.keepGoing.onSessionManaged(conversation, detail, 'person-stopped')).toBe(false)
  })
})
