import { afterEach, describe, expect, it, vi } from 'vitest'
import { conversationSourceRowKey } from '../../../../shared/conversation-source'
import { NEXT_STEP_SUGGESTION_MAX } from '../../../../shared/next-step-suggestions'
import { NEXT_STEPS_RPC } from '../../../../shared/next-step-suggestions-rpc'
import type { NextStepSuggestionService } from '../../../next-steps/next-step-suggestion-service'
import type { NextStepKeepGoingController } from '../../../next-steps/next-step-keep-going'
import {
  setNextStepKeepGoingController,
  setNextStepSuggestionService
} from '../../../next-steps/next-step-suggestion-slot'
import { decideNextSteps } from '../../../next-steps/next-step-decisions'
import type { NextStepJev } from '../../../next-steps/next-step-jev'
import { setNextStepJev } from '../../../next-steps/next-step-jev-slot'
import type { RpcContext, RpcMethod } from '../core'
import {
  NEXT_STEPS_METHODS,
  NextStepsAdPausesParams,
  NextStepsDecideParams,
  NextStepsGenerateParams,
  NextStepsKeepGoingParams,
  NextStepsListParams,
  NextStepsOfferParsedParams,
  NextStepsSuggestStartParams
} from './next-steps'

const turnAnswers = vi.hoisted(() => ({
  offerParsedForReply: vi.fn(async () => 'This conversation reports its own turns.'),
  currentNextSteps: vi.fn(async () => ({ turnKey: 't1', answered: false, revision: 3 })),
  currentNextStepTurn: vi.fn(async () => ({ observed: { turnKey: 't1' }, known: true }))
}))
vi.mock('../../../next-steps/next-step-turn-answers', () => turnAnswers)

const startSets = vi.hoisted(() => ({
  suggestNextStepStart: vi.fn(() => ({ set: { id: 'start-1' } })),
  decideNextStepStart: vi.fn(async () => ({
    set: { id: 'start-1' },
    queued: ['c1'],
    notQueued: []
  }))
}))
vi.mock('../../../next-steps/next-step-start-sets', () => startSets)

const decisions = vi.hoisted(() => ({
  decideNextSteps: vi.fn(async (_service: unknown, setId: string) => {
    // Stands in for the turn path's own check: this set is on an earlier turn.
    if (setId === 'stale-1') {
      throw new Error('These suggestions are for an earlier turn and can no longer be answered.')
    }
    return { set: { id: setId }, queued: ['s1'], notQueued: [] }
  })
}))
vi.mock('../../../next-steps/next-step-decisions', () => ({
  decideNextSteps: decisions.decideNextSteps,
  readOfferedNextSteps: (raw: unknown) => raw
}))

const conversation = { worktreeId: 'repo::/w', paneKey: 'tab-1:leaf-1', kind: 'pty' }
const person = {
  clientId: 'desktop-renderer',
  runtime: { getRuntimeId: () => 'execution-owner-runtime' }
} as unknown as RpcContext
const agent = {
  clientId: 'desktop-renderer',
  orchestrationCapability: 'cap'
} as unknown as RpcContext

const method = (name: string): RpcMethod => NEXT_STEPS_METHODS.find((entry) => entry.name === name)!
const call = (name: string, params: unknown, context: RpcContext = person) =>
  method(name).handler(method(name).params!.parse(params), context)

afterEach(() => setNextStepSuggestionService(null))

describe('nextSteps.* params', () => {
  it('accepts the documented shapes', () => {
    expect(NextStepsListParams.parse({})).toEqual({})
    expect(NextStepsListParams.parse({ worktreeId: 'w', conversation }).conversation).toEqual(
      conversation
    )
    expect(NextStepsGenerateParams.parse({ conversation, force: true }).force).toBe(true)
    for (const decision of [
      { action: 'run', suggestionIds: ['s1', 's2'] },
      { action: 'save', suggestionIds: ['s1'] },
      { action: 'dismiss' }
    ]) {
      expect(NextStepsDecideParams.parse({ setId: 'set-1', decision }).decision).toEqual(decision)
    }
    expect(
      NextStepsOfferParsedParams.parse({ conversation, messageId: 'm', suggestions: [{}] })
    ).toBeTruthy()
  })

  it('refuses malformed params before anything runs', () => {
    const refused = [
      () => NextStepsListParams.parse({ extra: 1 }),
      () => NextStepsListParams.parse({ executionRuntimeId: 'caller-selected-runtime' }),
      () => NextStepsGenerateParams.parse({ conversation: { ...conversation, kind: 'web' } }),
      () => NextStepsGenerateParams.parse({ conversation: { ...conversation, paneKey: '' } }),
      () => NextStepsDecideParams.parse({ setId: 'set-1', decision: { action: 'run' } }),
      () =>
        NextStepsDecideParams.parse({
          setId: 'set-1',
          decision: { action: 'run', suggestionIds: [] }
        }),
      () => NextStepsDecideParams.parse({ setId: '', decision: { action: 'dismiss' } }),
      () => NextStepsDecideParams.parse({ setId: 's', decision: { action: 'dismiss', x: 1 } }),
      () => NextStepsOfferParsedParams.parse({ conversation, messageId: 'm', suggestions: [] }),
      // A client never names the turn: the old turnKey shape is gone.
      () => NextStepsOfferParsedParams.parse({ conversation, turnKey: 't', suggestions: [{}] }),
      () =>
        NextStepsOfferParsedParams.parse({
          conversation,
          messageId: 'm',
          suggestions: Array.from({ length: NEXT_STEP_SUGGESTION_MAX + 1 }, () => ({}))
        })
    ]
    for (const parse of refused) {
      expect(parse).toThrow()
    }
  })
})

describe('nextSteps.* handlers', () => {
  it('says plainly when this host has no suggester', () => {
    expect(() => call(NEXT_STEPS_RPC.list, {})).toThrow(/not available on this host/)
  })

  it('lets the person decide and refuses an agent assertion', async () => {
    const service = {
      list: vi.fn(() => ({ sets: [], skips: [], revision: 1 })),
      generate: vi.fn(async () => ({ set: null, skipped: 'off' })),
      deps: { store: { get: () => ({ id: 'set-1', origin: 'ai', conversation }) } }
    } as unknown as NextStepSuggestionService
    setNextStepSuggestionService(service)
    await expect(call(NEXT_STEPS_RPC.list, { conversation })).resolves.toEqual({
      sets: [],
      skips: [],
      revision: 1,
      replyDecisions: [],
      executionRuntimeId: 'execution-owner-runtime'
    })
    await expect(
      call(NEXT_STEPS_RPC.decide, { setId: 'set-1', decision: { action: 'dismiss' } })
    ).resolves.toMatchObject({ queued: ['s1'] })
    await call(NEXT_STEPS_RPC.generate, { conversation, force: true })
    expect(service.generate).toHaveBeenCalledWith(conversation, { force: true })
    expect(() => call(NEXT_STEPS_RPC.list, {}, agent)).toThrow(/agent assertion/)
    expect(() =>
      call(NEXT_STEPS_RPC.decide, { setId: 'set-1', decision: { action: 'dismiss' } }, agent)
    ).toThrow(/agent assertion/)
    expect(() => call(NEXT_STEPS_RPC.generate, { conversation }, agent)).toThrow(/agent assertion/)
  })

  it('places a reply on the host’s own turn, answers held, and reads the current turn', async () => {
    const service = {} as unknown as NextStepSuggestionService
    setNextStepSuggestionService(service)
    const suggestions = [{ title: 'Review it', prompt: 'Review the diff.' }]
    await expect(
      call(NEXT_STEPS_RPC.offerParsed, { conversation, messageId: 'm1', suggestions })
    ).resolves.toEqual({ set: null, refused: 'This conversation reports its own turns.' })
    expect(turnAnswers.offerParsedForReply).toHaveBeenCalledWith(service, conversation, 'm1', [
      expect.objectContaining({ title: 'Review it' })
    ])
    expect(() => NextStepsOfferParsedParams.parse({ conversation, suggestions })).toThrow()
    await expect(call(NEXT_STEPS_RPC.current, { conversation })).resolves.toMatchObject({
      turnKey: 't1'
    })
    expect(turnAnswers.currentNextSteps).toHaveBeenCalledWith(service, conversation)
    expect(() => call(NEXT_STEPS_RPC.current, { conversation }, agent)).toThrow(/agent assertion/)
  })

  it('passes a status filter through and refuses an unknown status', async () => {
    const service = {
      list: vi.fn(() => ({ sets: [], skips: [], revision: 2 })),
      deps: {}
    } as unknown as NextStepSuggestionService
    setNextStepSuggestionService(service)
    await call(NEXT_STEPS_RPC.list, { statuses: ['pending'] })
    expect(service.list).toHaveBeenCalledWith({ statuses: ['pending'] })
    expect(() => NextStepsListParams.parse({ statuses: ['open'] })).toThrow()
    expect(() => NextStepsListParams.parse({ statuses: [] })).toThrow()
  })

  it('asks for a workspace’s suggested starts as the person, never as an agent', () => {
    const service = {} as unknown as NextStepSuggestionService
    setNextStepSuggestionService(service)
    expect(
      call(NEXT_STEPS_RPC.suggestStart, {
        worktreeId: 'repo::/w',
        taskId: 'btk_1',
        agent: 'claude',
        force: true
      })
    ).toEqual({ set: { id: 'start-1' } })
    expect(startSets.suggestNextStepStart).toHaveBeenCalledWith(service, {
      worktreeId: 'repo::/w',
      taskId: 'btk_1',
      agent: 'claude',
      force: true
    })
    call(NEXT_STEPS_RPC.suggestStart, { worktreeId: 'repo::/w' })
    expect(startSets.suggestNextStepStart).toHaveBeenLastCalledWith(service, {
      worktreeId: 'repo::/w',
      force: false
    })
    expect(() => call(NEXT_STEPS_RPC.suggestStart, { worktreeId: 'repo::/w' }, agent)).toThrow(
      /agent assertion/
    )
    for (const bad of [
      {},
      { worktreeId: '' },
      { worktreeId: 'w', extra: 1 },
      { worktreeId: 'w', taskId: '' }
    ]) {
      expect(() => NextStepsSuggestStartParams.parse(bad)).toThrow()
    }
  })

  it('routes decide by the stored set’s origin, never by the conversation param', async () => {
    const sets: Record<string, unknown> = {
      'start-1': {
        id: 'start-1',
        origin: 'start',
        worktreeId: 'repo::/w',
        status: 'pending',
        suggestions: []
      },
      'set-1': {
        id: 'set-1',
        origin: 'ai',
        worktreeId: 'repo::/w',
        conversation,
        status: 'pending'
      }
    }
    const service = {
      deps: { store: { get: (id: string) => sets[id], list: () => Object.values(sets) } },
      currentTurns: new Map()
    } as unknown as NextStepSuggestionService
    setNextStepSuggestionService(service)
    // A start set without the conversation that takes it is refused, whatever the client meant.
    await expect(
      call(NEXT_STEPS_RPC.decide, { setId: 'start-1', decision: { action: 'dismiss' } })
    ).rejects.toThrow(/answered from the new conversation/)
    await expect(
      call(NEXT_STEPS_RPC.decide, {
        setId: 'start-1',
        decision: { action: 'dismiss' },
        conversation: { ...conversation, worktreeId: 'repo::/other' }
      })
    ).rejects.toThrow(/another workspace/)
    // Any other set only from its own conversation.
    await expect(
      call(NEXT_STEPS_RPC.decide, {
        setId: 'set-1',
        decision: { action: 'dismiss' },
        conversation: { ...conversation, paneKey: 'tab-9:leaf-9' }
      })
    ).rejects.toThrow(/another conversation/)
    await expect(
      call(NEXT_STEPS_RPC.decide, { setId: 'set-1', decision: { action: 'dismiss' }, conversation })
    ).resolves.toMatchObject({ queued: ['s1'] })
    expect(() =>
      NextStepsDecideParams.parse({
        setId: 'start-1',
        decision: { action: 'dismiss' },
        conversation: { ...conversation, kind: 'web' }
      })
    ).toThrow()
    expect(() =>
      call(
        NEXT_STEPS_RPC.decide,
        { setId: 'start-1', decision: { action: 'dismiss' }, conversation },
        agent
      )
    ).toThrow(/agent assertion/)
  })

  it('sends a start set down the start path even where a turn set would be refused as stale', async () => {
    const stale = { ...conversation, paneKey: 'tab-4:leaf-4' }
    const sets: Record<string, unknown> = {
      'start-1': {
        id: 'start-1',
        origin: 'start',
        worktreeId: 'repo::/w',
        status: 'pending',
        suggestions: [{ id: 'c1', title: 'T', prompt: 'P', risk: 'safe', kind: 'other' }]
      },
      'stale-1': {
        id: 'stale-1',
        origin: 'ai',
        worktreeId: 'repo::/w',
        conversation: stale,
        turnKey: 'tab-4:leaf-4@1',
        status: 'pending'
      }
    }
    const service = {
      deps: { store: { get: (id: string) => sets[id], list: () => Object.values(sets) } },
      // The host's current turn for this conversation is newer than the stale set's.
      currentTurns: new Map([[conversationSourceRowKey(stale), { turnKey: 'tab-4:leaf-4@2' }]])
    } as unknown as NextStepSuggestionService
    setNextStepSuggestionService(service)
    decisions.decideNextSteps.mockClear()
    await expect(
      call(NEXT_STEPS_RPC.decide, {
        setId: 'stale-1',
        decision: { action: 'dismiss' },
        conversation: stale
      })
    ).rejects.toThrow(/earlier turn/)
    expect(decisions.decideNextSteps).toHaveBeenCalledTimes(1)
    // The start set never reaches the turn path: the start path answers, in its own words.
    await expect(
      call(NEXT_STEPS_RPC.decide, {
        setId: 'start-1',
        decision: { action: 'run', suggestionIds: ['c1'] },
        conversation: stale
      })
    ).rejects.toThrow(/already has messages/)
    expect(decisions.decideNextSteps).toHaveBeenCalledTimes(1)
  })
})

describe('nextSteps.keepGoing', () => {
  afterEach(() => setNextStepKeepGoingController(null))

  it('accepts 1–25 rounds and refuses anything else', () => {
    expect(NextStepsKeepGoingParams.parse({ conversation, enabled: true })).toEqual({
      conversation,
      enabled: true
    })
    expect(
      NextStepsKeepGoingParams.parse({ conversation, enabled: true, maxRounds: 25 })
    ).toBeTruthy()
    for (const bad of [
      { conversation, enabled: true, maxRounds: 0 },
      { conversation, enabled: true, maxRounds: 26 },
      { conversation, enabled: true, maxRounds: 2.5 },
      { conversation, enabled: 'yes' },
      { conversation },
      { conversation, enabled: true, extra: 1 }
    ]) {
      expect(() => NextStepsKeepGoingParams.parse(bad)).toThrow()
    }
  })

  it('is the person’s switch alone and lists its state beside the sets', async () => {
    setNextStepSuggestionService({
      list: vi.fn(() => ({ sets: [], skips: [], revision: 4 })),
      deps: {}
    } as unknown as NextStepSuggestionService)
    const state = { conversation, enabled: true, maxRounds: 2, roundsUsed: 0, startedAt: 1 }
    const controller = {
      setKeepGoing: vi.fn(() => state),
      list: vi.fn(() => [state]),
      onPersonDecided: vi.fn(),
      revision: 3
    } as unknown as NextStepKeepGoingController
    await expect(call(NEXT_STEPS_RPC.keepGoing, { conversation, enabled: true })).rejects.toThrow(
      /not available on this host/
    )
    setNextStepKeepGoingController(controller)
    await expect(
      call(NEXT_STEPS_RPC.keepGoing, { conversation, enabled: true, maxRounds: 2 })
    ).resolves.toEqual({ state })
    expect(controller.setKeepGoing).toHaveBeenCalledWith(
      conversation,
      true,
      2,
      'person-stopped',
      {}
    )
    // The current turn is read (after a restart, read back) before it is turned on.
    expect(turnAnswers.currentNextStepTurn).toHaveBeenCalledWith(expect.anything(), conversation)
    await expect(
      call(NEXT_STEPS_RPC.keepGoing, { conversation, enabled: true }, agent)
    ).rejects.toThrow(/agent assertion/)
    await expect(
      Promise.resolve(call(NEXT_STEPS_RPC.list, { conversation }))
    ).resolves.toMatchObject({
      revision: 4,
      keepGoingRevision: 3,
      keepGoing: [state]
    })
    expect(controller.list).toHaveBeenCalledWith({ conversation })
  })

  it('switches the mode and push prompt for the person only, bounded', async () => {
    setNextStepSuggestionService({} as NextStepSuggestionService)
    const controller = { setKeepGoing: vi.fn(() => ({})) } as unknown as NextStepKeepGoingController
    setNextStepKeepGoingController(controller)
    const run = { mode: 'push-for-better', pushPrompt: 'Sharper.' }
    await call(NEXT_STEPS_RPC.keepGoing, { conversation, enabled: true, ...run })
    expect(controller.setKeepGoing).toHaveBeenCalledWith(
      conversation,
      true,
      undefined,
      'person-stopped',
      run
    )
    await expect(
      call(NEXT_STEPS_RPC.keepGoing, { conversation, enabled: true, ...run }, agent)
    ).rejects.toThrow(/agent assertion/)
    for (const bad of [
      { mode: 'autopilot' },
      { pushPrompt: 'x'.repeat(2001) },
      { pushPrompt: 7 }
    ]) {
      expect(() =>
        NextStepsKeepGoingParams.parse({ conversation, enabled: true, ...bad })
      ).toThrow()
    }
  })

  it('refuses `auto` from any caller: only the host’s own Keep going decides automatically', () => {
    expect(() =>
      NextStepsDecideParams.parse({
        setId: 'set-1',
        decision: { action: 'run', suggestionIds: ['s1'], auto: true }
      })
    ).toThrow()
  })

  it('passes a person-acted stop through', async () => {
    setNextStepSuggestionService({} as NextStepSuggestionService)
    const controller = { setKeepGoing: vi.fn(() => ({})) } as unknown as NextStepKeepGoingController
    setNextStepKeepGoingController(controller)
    await call(NEXT_STEPS_RPC.keepGoing, { conversation, enabled: false, reason: 'person-acted' })
    expect(controller.setKeepGoing).toHaveBeenCalledWith(
      conversation,
      false,
      undefined,
      'person-acted',
      {}
    )
    expect(() =>
      NextStepsKeepGoingParams.parse({ conversation, enabled: false, reason: 'because' })
    ).toThrow()
  })

  it('stops keep going before the person’s answer runs, even one that fails', async () => {
    const set = { id: 'set-1', conversation }
    setNextStepSuggestionService({
      deps: { store: { get: () => set } }
    } as unknown as NextStepSuggestionService)
    const order: string[] = []
    const controller = {
      onPersonDecided: vi.fn(() => order.push('stopped'))
    } as unknown as NextStepKeepGoingController
    setNextStepKeepGoingController(controller)
    vi.mocked(decideNextSteps).mockImplementationOnce(async () => {
      order.push('decided')
      throw new Error('refused')
    })
    await expect(
      call(NEXT_STEPS_RPC.decide, {
        setId: 'set-1',
        decision: { action: 'run', suggestionIds: ['s1'] }
      })
    ).rejects.toThrow('refused')
    expect(controller.onPersonDecided).toHaveBeenCalledWith(set)
    expect(order).toEqual(['stopped', 'decided'])
  })
})

describe('nextSteps.adPauses', () => {
  afterEach(() => setNextStepKeepGoingController(null))

  it('sets one conversation’s ad-pause choice for the person only', async () => {
    const state = { conversation, enabled: false, adPauses: 'ask-first' }
    const controller = {
      setAdPauses: vi.fn(() => state)
    } as unknown as NextStepKeepGoingController
    setNextStepKeepGoingController(controller)
    expect(call(NEXT_STEPS_RPC.adPauses, { conversation, adPauses: 'ask-first' })).toEqual({
      state
    })
    call(NEXT_STEPS_RPC.adPauses, { conversation, adPauses: null })
    expect(controller.setAdPauses).toHaveBeenNthCalledWith(1, conversation, 'ask-first')
    expect(controller.setAdPauses).toHaveBeenNthCalledWith(2, conversation, null)
    await expect(
      Promise.resolve().then(() =>
        call(NEXT_STEPS_RPC.adPauses, { conversation, adPauses: 'allowed' }, agent)
      )
    ).rejects.toThrow(/agent assertion/)
    for (const bad of [
      { conversation, adPauses: 'never' },
      { conversation },
      { conversation, adPauses: 'allowed', extra: 1 }
    ]) {
      expect(() => NextStepsAdPausesParams.parse(bad)).toThrow()
    }
  })
})

describe('nextSteps.linkTask', () => {
  afterEach(() => setNextStepJev(null))

  it('tells JEV which card the conversation serves, as the person only', async () => {
    const linkTask = vi.fn()
    setNextStepJev({ linkTask } as unknown as NextStepJev)
    expect(await call(NEXT_STEPS_RPC.linkTask, { conversation, taskId: 'btk_1' })).toEqual({
      ok: true
    })
    await call(NEXT_STEPS_RPC.linkTask, { conversation, taskId: null })
    expect(linkTask.mock.calls.map(([, taskId]) => taskId)).toEqual(['btk_1', null])
    expect(() => call(NEXT_STEPS_RPC.linkTask, { conversation, taskId: 'btk 1' })).toThrow()
    expect(() => call(NEXT_STEPS_RPC.linkTask, { conversation, taskId: 'btk_1' }, agent)).toThrow(
      /agent assertion/
    )
  })

  it('is a quiet no-op on a host without JEV', async () => {
    expect(await call(NEXT_STEPS_RPC.linkTask, { conversation, taskId: 'btk_1' })).toEqual({
      ok: true
    })
  })
})
