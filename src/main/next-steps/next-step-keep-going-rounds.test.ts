import { describe, expect, it } from 'vitest'
import type { NextStepKeepGoingStopReason } from '../../shared/next-step-keep-going'
import type { NextStepSuggestion } from '../../shared/next-step-suggestions'
import { decideNextSteps } from './next-step-decisions'
import {
  conversation,
  harness,
  MARKER,
  risky,
  safe,
  withKeepGoingDirectory
} from './next-step-keep-going-harness'

withKeepGoingDirectory()

describe('what may run by itself', () => {
  it.each([
    ['a step the label calls risky', risky('r1')],
    ['a backticked command', safe('c', { prompt: 'Run `pnpm test` again.' })],
    ['a path line', safe('c', { prompt: './scripts/check.sh' })],
    [
      'a shipping kind with plain words',
      safe('c', { kind: 'ship', prompt: 'Tidy the changelog.' })
    ],
    ['a follow-up', safe('c', { kind: 'follow-up', prompt: 'Look at the flaky test next.' })],
    ['a commit', safe('c', { kind: 'other', prompt: 'Commit the change.' })],
    ['a normal step', safe('c', { kind: 'fix', prompt: 'Add a regression test for the parser.' })]
  ])('runs %s', async (_case, step) => {
    const h = harness()
    h.keepGoing.setKeepGoing(conversation, true)
    h.offer('t1', [step, safe('s2')])
    await h.settle()
    expect(h.sent()).toHaveLength(1)
    expect(h.lastSent().replace(MARKER, '')).toBe(step.prompt)
    expect(h.state()).toMatchObject({ enabled: true, roundsUsed: 1 })
  })

  it.each<[string, NextStepSuggestion, NextStepKeepGoingStopReason]>([
    ['a deploy step', safe('d', { prompt: 'Deploy the change to staging.' }), 'needs-you-deploy'],
    [
      'git clean',
      safe('c', { prompt: 'Run git clean -fdx in this workspace.' }),
      'needs-you-delete-data'
    ],
    ['rm -rf', safe('c', { prompt: 'rm -rf build' }), 'needs-you-delete-data'],
    ['a push to main', safe('p', { prompt: 'Push this to main.' }), 'needs-you-shared-branch'],
    ['a force push', safe('p', { prompt: 'Force-push the branch.' }), 'needs-you-shared-branch'],
    ['a reset --hard', safe('h', { prompt: 'git reset --hard HEAD~2' }), 'needs-you-history'],
    ['an email', safe('e', { prompt: 'Send an email to the team.' }), 'needs-you-send'],
    ['a refund', safe('m', { prompt: 'Refund the customer.' }), 'needs-you-payment'],
    ['a token', safe('k', { prompt: 'Rotate the API key.' }), 'needs-you-credentials'],
    [
      'an ad budget raise',
      safe('a', { prompt: 'Raise the SD25 daily budget to $300.' }),
      'needs-you-ad-spend'
    ],
    ['an ad set back on', safe('a', { prompt: 'Turn ad set 4 back on.' }), 'needs-you-ad-spend'],
    [
      'a whole-campaign pause',
      safe('a', { prompt: 'Pause the SD25 Meta campaign.' }),
      'needs-you-ad-campaign-pause'
    ],
    [
      'an Enterprise ad set pause',
      safe('a', { prompt: 'Pause the Enterprise webinar ad set.' }),
      'needs-you-ad-enterprise'
    ],
    [
      'a pause beside a budget raise',
      safe('a', { prompt: 'Pause ad set 4 and raise the SD25 daily budget to $300.' }),
      'needs-you-ad-spend'
    ],
    [
      'a deploy in the why',
      safe('w', { prompt: 'Tidy it.', why: 'So we can deploy today.' }),
      'needs-you-deploy'
    ]
  ])('stops on %s, never skipping ahead', async (_case, step, reason) => {
    const h = harness()
    h.keepGoing.setKeepGoing(conversation, true)
    h.offer('t1', [step, safe('s2')])
    await h.settle()
    expect(h.sent()).toEqual([])
    h.expectStopped(reason)
  })
})

describe('ad pauses (Sal, 2026-09-26)', () => {
  const pause = safe('a', { title: 'Pause ad set 4', prompt: 'Pause ad set 4 in SD25.' })

  it('runs a step that only pauses ads by default, and records it', async () => {
    const h = harness()
    h.keepGoing.setKeepGoing(conversation, true)
    h.offer('t1', [pause, safe('s2')])
    await h.settle()
    expect(h.lastSent().replace(MARKER, '')).toBe(pause.prompt)
    expect(h.state()).toMatchObject({
      enabled: true,
      roundsUsed: 1,
      lastAdPause: { round: 1, title: 'Pause ad set 4' }
    })
    expect(h.log().at(-1)).toMatchObject({
      decision: { action: 'run', suggestionIds: ['a'], auto: true, adPause: true }
    })
  })

  it('records nothing for a round that pauses no ads', async () => {
    const h = harness()
    h.keepGoing.setKeepGoing(conversation, true)
    h.offer('t1', [safe('s1')])
    await h.settle()
    expect(h.state().lastAdPause).toBeUndefined()
    expect(h.log().at(-1)).not.toHaveProperty('decision.adPause')
  })

  it('stops on a pause when the global setting asks first', async () => {
    const h = harness()
    h.flags.adPauses = 'ask-first'
    h.keepGoing.setKeepGoing(conversation, true)
    h.offer('t1', [pause, safe('s2')])
    await h.settle()
    expect(h.sent()).toEqual([])
    h.expectStopped('needs-you-ad-pause')
  })

  it('stops on a pause when this session asks first, over an allowed global setting', async () => {
    const h = harness()
    h.flags.adPauses = 'allowed'
    h.keepGoing.setAdPauses(conversation, 'ask-first')
    h.keepGoing.setKeepGoing(conversation, true)
    expect(h.state().adPauses).toBe('ask-first')
    h.offer('t1', [pause, safe('s2')])
    await h.settle()
    expect(h.sent()).toEqual([])
    h.expectStopped('needs-you-ad-pause')
    // The choice outlives the run.
    expect(h.state().adPauses).toBe('ask-first')
  })

  it('runs a pause when this session allows it, over an ask-first global setting', async () => {
    const h = harness()
    h.flags.adPauses = 'ask-first'
    h.keepGoing.setAdPauses(conversation, 'allowed')
    h.keepGoing.setKeepGoing(conversation, true)
    h.offer('t1', [pause, safe('s2')])
    await h.settle()
    expect(h.lastSent().replace(MARKER, '')).toBe(pause.prompt)
    expect(h.state()).toMatchObject({ enabled: true, lastAdPause: { round: 1 } })
  })

  it('follows the global setting again once this session clears its choice', () => {
    const h = harness()
    h.keepGoing.setAdPauses(conversation, 'ask-first')
    expect(h.keepGoing.setAdPauses(conversation, null)).not.toHaveProperty('adPauses')
  })
})

describe('the cap and the person, under slow timing', () => {
  it('never runs past the cap when the decision log is slow', async () => {
    let release: () => void = () => {}
    const slowLog = new Promise<void>((resolve) => (release = resolve))
    const h = harness({
      decide: (...args) =>
        decideNextSteps(...args).then(async (result) => {
          await slowLog
          return result
        })
    })
    h.keepGoing.setKeepGoing(conversation, true, 1)
    h.offer('t1', [safe('s1')])
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(h.sent()).toHaveLength(1)
    // The drain delivers and the turn finishes while decide is still writing its log.
    h.deliver()
    h.keepGoing.onDelivered(conversation, h.queue.entries[0]!.id)
    expect(h.state().roundsUsed).toBe(1)
    h.finish('t2', h.lastSent())
    h.expectStopped('cap-reached')
    h.offer('t2', [safe('s2')])
    await h.settle()
    release()
    await h.settle()
    expect(h.sent()).toHaveLength(1)
    expect(h.state()).toMatchObject({ enabled: false, roundsUsed: 1, stopReason: 'cap-reached' })
  })

  it('counts a delivered round once, however many ways it is confirmed', async () => {
    const h = harness()
    await h.firstRound(5)
    h.keepGoing.onDelivered(conversation, h.queue.entries[0]!.id)
    h.finish('t2', h.lastSent())
    expect(h.state()).toMatchObject({ enabled: true, roundsUsed: 1 })
  })

  it('stops when the person types, and the write-time check then refuses the round', async () => {
    const h = harness()
    h.keepGoing.setKeepGoing(conversation, true)
    h.offer('t1', [safe('s1')])
    await h.settle()
    const entry = h.queue.entries[0]!
    h.keepGoing.setKeepGoing(conversation, false, undefined, 'person-typing')
    h.expectStopped('person-typing')
    expect(() => h.keepGoing.assertDelivery(conversation, entry)).toThrow()
    expect(h.queue.entries[0]!.state).toBe('failed')
  })

  it('stops idempotently, storing nothing for a conversation that never ran', () => {
    const h = harness()
    expect(h.keepGoing.setKeepGoing(conversation, false, undefined, 'person-acted')).toMatchObject({
      enabled: false
    })
    expect(h.state()).toBeUndefined()
  })
})
