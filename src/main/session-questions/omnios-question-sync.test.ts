import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionDecision } from '../../shared/session-decisions'
import { requestConsoleWorkflow } from '../backoffice/console-workflow-transport'
import { routes } from '../backoffice/console-workflow-routes'
import {
  cardTyped,
  cardTypingUncertain,
  noteClaimerPolled,
  resetAnswerHandoverForTests
} from '../answer-delivery/answer-delivery-handover'
import {
  consoleQuestionTransport,
  encodeHostQuery,
  createOmniosQuestionsSync,
  type OmniosQuestionTransport
} from './omnios-question-runtime'
import {
  OmniosQuestionPublisherState,
  omniosQuestionFingerprint,
  omniosQuestionItems,
  runOmniosAnswerRound,
  type OmniosQuestionAnswer,
  type OmniosQuestionItem
} from './omnios-question-sync'

vi.mock('../backoffice/console-workflow-transport', () => ({ requestConsoleWorkflow: vi.fn() }))
vi.mock('../session-ledger/ledger-client', () => ({ currentLedgerPrincipal: () => 'user_sal' }))

const PROMPT = JSON.stringify({ questions: [{ question: 'Ship it?', options: [] }] })

function decision(overrides: Partial<SessionDecision> = {}): SessionDecision {
  return {
    key: 'k1',
    paneKey: 'tab-1:leaf-1',
    worktreeId: 'wt-1',
    agent: 'claude',
    askedAt: Date.UTC(2026, 9, 11, 12),
    toolUseId: 'toolu_1',
    toolName: 'AskUserQuestion',
    interactivePrompt: PROMPT,
    context: null,
    providerSession: { key: 'session_id', id: 'sess-1' } as SessionDecision['providerSession'],
    endedAt: null,
    scores: null,
    updatedAt: 0,
    title: 'Release notes',
    questions: [
      {
        question: 'Ship it?',
        header: 'Ship',
        multiSelect: false,
        options: [{ label: 'Yes', description: 'now' }, { label: 'No' }]
      }
    ],
    scoreUnavailable: null,
    ...overrides
  }
}

function item(fingerprint: string, title = 't'): OmniosQuestionItem {
  return {
    fingerprint,
    paneKey: 'p',
    sessionId: 's',
    toolUseId: '',
    title,
    agent: 'claude',
    askedAt: '2026-10-11T12:00:00.000Z',
    questions: []
  }
}

function answer(id: string, fingerprint: string): OmniosQuestionAnswer {
  return {
    id,
    fingerprint,
    paneKey: 'p',
    sessionId: 's',
    toolUseId: '',
    answers: { 'Ship it?': 'Yes' },
    skipped: false
  }
}

describe('OmniOS question items', () => {
  it('fingerprints the session question identity plus the asking tool call', () => {
    const expected = createHash('sha256').update(`sess-1\n${PROMPT}\ntoolu_1`).digest('hex')
    expect(omniosQuestionFingerprint(decision())).toBe(expected)
    expect(omniosQuestionFingerprint(decision({ providerSession: null }))).toBe(
      createHash('sha256').update(`tab-1:leaf-1\n${PROMPT}\ntoolu_1`).digest('hex')
    )
  })

  it('gives the same question asked again a new fingerprint (OmniOS never reopens one)', () => {
    const first = omniosQuestionFingerprint(decision())
    expect(omniosQuestionFingerprint(decision({ toolUseId: 'toolu_2' }))).not.toBe(first)
    const noTool = omniosQuestionFingerprint(decision({ toolUseId: null, askedAt: 1 }))
    expect(omniosQuestionFingerprint(decision({ toolUseId: null, askedAt: 2 }))).not.toBe(noTool)
    expect(omniosQuestionFingerprint(decision({ toolUseId: null, askedAt: 1 }))).toBe(noTool)
  })

  it('lists live questions once, in the OmniOS shape, and leaves ended ones out', () => {
    const items = omniosQuestionItems([
      decision(),
      decision({ key: 'k2', paneKey: 'tab-2:leaf-1' }),
      decision({ key: 'k3', interactivePrompt: 'other', endedAt: 5 })
    ])
    expect(items).toHaveLength(1)
    expect(items[0]).toEqual({
      fingerprint: omniosQuestionFingerprint(decision()),
      paneKey: 'tab-1:leaf-1',
      sessionId: 'sess-1',
      toolUseId: 'toolu_1',
      title: 'Release notes',
      agent: 'claude',
      askedAt: '2026-10-11T12:00:00.000Z',
      questions: [
        {
          header: 'Ship',
          question: 'Ship it?',
          multiSelect: false,
          options: [
            { label: 'Yes', description: 'now' },
            { label: 'No', description: '' }
          ]
        }
      ]
    })
  })
})

describe('OmniosQuestionPublisherState', () => {
  it('sends new items, then only changes and resolutions, and nothing when unchanged', () => {
    const state = new OmniosQuestionPublisherState()
    const first = state.next('studio', [item('a'), item('b')], false)
    expect(first).toEqual({
      host: 'studio',
      full: false,
      items: [item('a'), item('b')],
      resolved: []
    })
    state.accepted(first!)
    expect(state.next('studio', [item('a'), item('b')], false)).toBeNull()
    const second = state.next('studio', [item('a', 'renamed'), item('c')], false)
    expect(second).toEqual({
      host: 'studio',
      full: false,
      items: [item('a', 'renamed'), item('c')],
      resolved: ['b']
    })
    state.accepted(second!)
    expect(state.next('studio', [item('a', 'renamed'), item('c')], false)).toBeNull()
  })

  it('keeps unaccepted changes due until a sync succeeds', () => {
    const state = new OmniosQuestionPublisherState()
    expect(state.next('h', [item('a')], false)?.items).toEqual([item('a')])
    expect(state.next('h', [item('a')], false)?.items).toEqual([item('a')])
  })

  it('lists everything on a full sync, including the gone ones as resolved', () => {
    const state = new OmniosQuestionPublisherState()
    state.accepted({ host: 'h', full: false, items: [item('a'), item('b')], resolved: [] })
    const full = state.next('h', [item('a')], true)
    expect(full).toEqual({ host: 'h', full: true, items: [item('a')], resolved: ['b'] })
    expect(state.next('h', [], true)).toEqual({
      host: 'h',
      full: true,
      items: [],
      resolved: ['a', 'b']
    })
  })
})

describe('runOmniosAnswerRound', () => {
  it('applies a pending answer, then acknowledges it delivered', async () => {
    const calls: string[] = []
    const result = await runOmniosAnswerRound({
      fetchAnswers: async () => [answer('7', 'fp')],
      isPending: () => true,
      apply: async () => {
        calls.push('apply')
        return { delivered: true }
      },
      ack: async (id, outcome) => {
        calls.push(`ack ${id} ${JSON.stringify(outcome)}`)
        return true
      },
      unacked: new Set()
    })
    expect(calls).toEqual(['apply', 'ack 7 {"delivered":true}'])
    expect(result).toEqual({ ok: true, delivered: 1 })
  })

  it('acknowledges not delivered, without applying, when the question is gone', async () => {
    const apply = vi.fn()
    const ack = vi.fn(async () => true)
    await runOmniosAnswerRound({
      fetchAnswers: async () => [answer('8', 'gone')],
      isPending: () => false,
      apply,
      ack,
      unacked: new Set()
    })
    expect(apply).not.toHaveBeenCalled()
    expect(ack).toHaveBeenCalledWith('8', {
      delivered: false,
      error: expect.stringContaining('no longer waiting')
    })
  })

  it('reports an apply failure, thrown or refused, as not delivered', async () => {
    const ack = vi.fn(async () => true)
    await runOmniosAnswerRound({
      fetchAnswers: async () => [answer('1', 'a'), answer('2', 'b')],
      isPending: () => true,
      apply: async (a) => {
        if (a.id === '1') {
          throw new Error('boom secret')
        }
        return { delivered: false, error: 'refused' }
      },
      ack,
      unacked: new Set()
    })
    expect(ack.mock.calls).toEqual([
      ['1', { delivered: false, error: 'The desktop could not apply this answer.' }],
      ['2', { delivered: false, error: 'refused' }]
    ])
  })

  it('re-acknowledges a typed answer whose ack was lost, without typing it again', async () => {
    const unacked = new Set<string>()
    const apply = vi.fn(async () => ({ delivered: true }) as const)
    const ack = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const deps = { fetchAnswers: async () => [answer('9', 'fp')], apply, ack, unacked }
    await runOmniosAnswerRound({ ...deps, isPending: () => true })
    expect(unacked.has('9')).toBe(true)
    await runOmniosAnswerRound({ ...deps, isPending: () => false })
    expect(apply).toHaveBeenCalledTimes(1)
    expect(ack).toHaveBeenLastCalledWith('9', { delivered: true })
    expect(unacked.size).toBe(0)
  })

  it('does nothing when the answers cannot be read', async () => {
    const ack = vi.fn()
    expect(
      await runOmniosAnswerRound({
        fetchAnswers: async () => null,
        isPending: () => true,
        apply: vi.fn(),
        ack,
        unacked: new Set()
      })
    ).toEqual({ ok: false, delivered: 0 })
    expect(ack).not.toHaveBeenCalled()
  })
})

describe('runOmniosAnswerRound beside the delivery claimer', () => {
  beforeEach(() => resetAnswerHandoverForTests())
  const keyed = (id: string, key: string): OmniosQuestionAnswer => ({
    ...answer(id, 'fp'),
    deliveryKey: key
  })

  it('leaves keyed answers to a polling claimer, without typing or acknowledging them', async () => {
    noteClaimerPolled(['question'])
    const apply = vi.fn(async (_a: OmniosQuestionAnswer) => ({ delivered: true }) as const)
    const ack = vi.fn(async (_id: string) => true)
    await runOmniosAnswerRound({
      fetchAnswers: async () => [keyed('1', 'question:1:a1'), answer('2', 'fp')],
      isPending: () => true,
      apply,
      ack,
      unacked: new Set()
    })
    expect(apply.mock.calls.map(([a]) => a.id)).toEqual(['2'])
    expect(ack.mock.calls.map(([id]) => id)).toEqual(['2'])
  })

  it('types a keyed answer when no claimer polls, and marks it so the claimer only follows it', async () => {
    const apply = vi.fn(async () => ({ delivered: true }) as const)
    await runOmniosAnswerRound({
      fetchAnswers: async () => [keyed('1', 'question:1:a1')],
      isPending: () => true,
      apply,
      ack: async () => true,
      unacked: new Set()
    })
    expect(apply).toHaveBeenCalledTimes(1)
    expect(cardTyped('question:1:a1')).toBe(true)
  })

  it('does not fail a keyed answer whose card ended: its delivery reopens the session', async () => {
    const ack = vi.fn(async () => true)
    await runOmniosAnswerRound({
      fetchAnswers: async () => [keyed('1', 'question:1:a1')],
      isPending: () => false,
      apply: vi.fn(),
      ack,
      unacked: new Set()
    })
    expect(ack).not.toHaveBeenCalled()
  })

  it('never types a keyed answer twice after an unconfirmed attempt, but types a new answer round', async () => {
    const apply = vi.fn(
      async (_a: OmniosQuestionAnswer) =>
        ({ delivered: false, error: 'The desktop window did not confirm the answer.' }) as const
    )
    const round = (key: string) =>
      runOmniosAnswerRound({
        fetchAnswers: async () => [keyed('1', key)],
        isPending: () => true,
        apply,
        ack: async () => false,
        unacked: new Set()
      })
    await round('question:1:a1')
    expect(cardTypingUncertain('question:1:a1')).toBe(true)
    await round('question:1:a1')
    expect(apply).toHaveBeenCalledTimes(1)
    await round('question:1:a2')
    expect(apply).toHaveBeenCalledTimes(2)
  })
})

describe('createOmniosQuestionsSync', () => {
  function transport(): OmniosQuestionTransport & { bodies: unknown[]; fail: boolean } {
    const t = {
      bodies: [] as unknown[],
      fail: false,
      sync: vi.fn(async (body: unknown) => {
        t.bodies.push(body)
        return !t.fail
      }),
      answers: vi.fn(async () => []),
      ack: vi.fn(async () => true)
    }
    return t
  }

  it('starts with a full sync, diffs after, resyncs fully each minute, and retries failures', async () => {
    let current = [item('a')]
    const t = transport()
    const sync = createOmniosQuestionsSync({
      host: 'studio',
      list: async () => current,
      isPending: () => true,
      apply: vi.fn(),
      transport: t,
      principal: () => 'user_sal'
    })
    expect(await sync.publish(false, 1_000)).toBe(true)
    expect(t.bodies.at(-1)).toMatchObject({ full: true, items: [item('a')], resolved: [] })
    await sync.publish(false, 2_000)
    expect(t.bodies).toHaveLength(1)
    current = []
    t.fail = true
    expect(await sync.publish(false, 3_000)).toBe(false)
    t.fail = false
    await sync.publish(false, 4_000)
    expect(t.bodies.at(-1)).toEqual({ host: 'studio', full: false, items: [], resolved: ['a'] })
    await sync.publish(false, 62_000)
    expect(t.bodies.at(-1)).toEqual({ host: 'studio', full: true, items: [], resolved: [] })
  })

  it("sends this runtime's session-host id when it has one", async () => {
    const t = transport()
    let hostId: string | undefined
    const sync = createOmniosQuestionsSync({
      host: 'studio',
      list: async () => [item('a')],
      isPending: () => true,
      apply: vi.fn(),
      hostId: () => hostId,
      transport: t,
      principal: () => 'user_sal'
    })
    await sync.publish(false, 1_000)
    expect(t.bodies.at(-1)).not.toHaveProperty('hostId')
    hostId = 'host_studio'
    await sync.publish(true, 2_000)
    expect(t.bodies.at(-1)).toMatchObject({ host: 'studio', hostId: 'host_studio' })
  })
})

describe('consoleQuestionTransport', () => {
  it('calls the OmniOS session-question routes over the signed-person transport', async () => {
    const request = vi.mocked(requestConsoleWorkflow)
    request.mockResolvedValue({ ok: true, data: { answers: [] } } as never)
    await consoleQuestionTransport.sync(
      { host: 'h', full: true, items: [], resolved: [] },
      'user_sal'
    )
    await consoleQuestionTransport.answers("Sal's Mac (2)", 'user_sal')
    await consoleQuestionTransport.ack('12', { delivered: false, error: 'gone' }, 'user_sal')
    expect(await consoleQuestionTransport.ack('../x', { delivered: true }, 'user_sal')).toBe(false)
    expect(request.mock.calls.map((call) => [call[0], call[1], call[3]])).toEqual([
      ['/api/session-questions/sync', 'POST', { host: 'h', full: true, items: [], resolved: [] }],
      ['/api/session-questions/answers?host=Sal%27s%20Mac%20%282%29', 'GET', undefined],
      ['/api/session-questions/12/ack', 'POST', { delivered: false, error: 'gone' }]
    ])
  })

  it('reads the wrapped answers list, and takes an ack 404 not_pending as already acknowledged', async () => {
    const request = vi.mocked(requestConsoleWorkflow)
    request.mockResolvedValueOnce({
      ok: true,
      data: { answers: [answer('9', 'f'.repeat(64))] }
    } as never)
    expect(await consoleQuestionTransport.answers('h', 'user_sal')).toHaveLength(1)
    request.mockResolvedValueOnce({
      ok: false,
      error: { code: 'not_pending', message: 'no answer is waiting' }
    } as never)
    expect(await consoleQuestionTransport.ack('9', { delivered: true }, 'user_sal')).toBe(true)
    request.mockResolvedValueOnce({
      ok: false,
      error: { code: 'backoffice_refused', message: 'down' }
    } as never)
    expect(await consoleQuestionTransport.ack('9', { delivered: true }, 'user_sal')).toBe(false)
  })
})

describe('session question routes', () => {
  it('are admitted by the console transport allowlist', () => {
    const admits = (method: 'GET' | 'POST', path: string) =>
      routes[method].some((route) => route.test.test(path))
    expect(admits('POST', '/api/session-questions/sync')).toBe(true)
    expect(admits('POST', '/api/session-questions/123/ack')).toBe(true)
    expect(admits('POST', '/api/session-questions/abc/ack')).toBe(false)
    expect(
      admits('GET', `/api/session-questions/answers?host=${encodeHostQuery('Sal’s Mac (2)')}`)
    ).toBe(true)
    expect(admits('GET', '/api/session-questions/answers?host=a&x=1')).toBe(false)
  })
})
