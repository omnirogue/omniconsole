import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { AgentHookSource } from '../../shared/agent-hook-relay'
import type { AgentHookEventPayload } from '../../shared/agent-hook-listener/listener-event'
import type { SessionSearchHit } from '../../shared/session-search-types'
import {
  createPriorWorkShadow,
  mergePriorWorkCandidates,
  PRIOR_WORK_SHADOW_DISABLED_ENV,
  PRIOR_WORK_SHADOW_OFF_FILE,
  PriorWorkShadow,
  priorWorkQueryTerms,
  rankProjectFolders,
  type PriorWorkCandidate,
  type PriorWorkShadowDeps,
  type PriorWorkShadowRecord
} from './prior-work-shadow'
import { AgentHookServer, _internals } from './server'
import { buildBody, PANE, postHookEvent } from './server.test-fixtures'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))

// Shared with the eval's Python port (Intelligence-10x metrics/prior_work_eval.py --self-test).
const QUERY_TERM_FIXTURES: [string, string[]][] = [
  [
    'Can you check the prompt-hook shadow log and fix the 300 ms budget?',
    ['prompt', 'hook', 'shadow', 'log']
  ],
  [
    'Stripe Stripe refunds 2026 webhook refunds dashboard alerts',
    ['stripe', 'refunds', 'webhook', 'dashboard']
  ],
  ['Café menü für Ümit', ['café', 'menü', 'für', 'ümit']],
  ['Please check this and let me know', []],
  ['W2-A8 prior_work pointer', ['prior', 'work', 'pointer']]
]

const PROMPT = 'Review the prompt hook shadow logs before the refunds webhooks change'

type FakeSearch = Pick<NonNullable<ReturnType<PriorWorkShadowDeps['sessionSearch']>>, 'search'>

function hit(sessionId: string, title: string, score: number): SessionSearchHit {
  return { sessionKey: `claude:${sessionId}`, sessionId, title, score } as SessionSearchHit
}

function promptEvent(
  prompt: string,
  overrides: Partial<AgentHookEventPayload> = {}
): AgentHookEventPayload {
  return {
    paneKey: 'tab-1:pane-1',
    connectionId: null,
    hasExplicitPrompt: true,
    hookEventName: 'UserPromptSubmit',
    providerSession: { key: 'session_id', id: 'session-new' },
    payload: { state: 'working', prompt },
    ...overrides
  } as AgentHookEventPayload
}

function sessionStart(source: 'startup' | 'resume' | 'clear'): AgentHookEventPayload {
  return promptEvent('', {
    hookEventName: 'SessionStart',
    sessionStartSource: source,
    hasExplicitPrompt: false
  })
}

let logsDirectory: string
let projectsDirectory: string
let sink: { push: Mock<(record: unknown) => void> }

function records(): PriorWorkShadowRecord[] {
  return sink.push.mock.calls.map(([record]) => record as PriorWorkShadowRecord)
}

function makeShadow(
  search: FakeSearch['search'] | null,
  overrides: Partial<PriorWorkShadowDeps> = {}
): PriorWorkShadow {
  return new PriorWorkShadow({
    logsDirectory,
    projectsDirectory,
    sessionSearch: () => (search ? { state: 'ready', search } : null),
    sink,
    ...overrides
  })
}

function observe(shadow: PriorWorkShadow, event: AgentHookEventPayload, source?: AgentHookSource) {
  shadow.observe(source ?? 'claude', event, { payload: { prompt: event.payload.prompt } })
}

function sha16(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

const settle = (ms = 60): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'prior-work-shadow-'))
  logsDirectory = join(root, 'logs')
  projectsDirectory = join(root, 'Projects')
  await mkdir(logsDirectory)
  for (const name of [
    'Prompt-Hook-Shadow-2026-09-24',
    'Refund-Webhooks-2026-08-01',
    'Intelligence-10x-2026-10-10',
    '.hidden-prompt-hook'
  ]) {
    await mkdir(join(projectsDirectory, name), { recursive: true })
  }
  await writeFile(join(projectsDirectory, 'prompt-hook-notes.md'), 'not a folder')
  sink = { push: vi.fn<(record: unknown) => void>() }
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(join(logsDirectory, '..'), { recursive: true, force: true })
})

describe('priorWorkQueryTerms', () => {
  it.each(QUERY_TERM_FIXTURES)('keeps the topic words of %j', (prompt, expected) => {
    expect(priorWorkQueryTerms(prompt)).toEqual(expected)
  })
})

describe('rankProjectFolders', () => {
  it('matches folder words to prompt words, ignoring dates, case, plurals and camelCase', () => {
    expect(
      rankProjectFolders(
        [
          'Intelligence-10x-2026-10-10',
          'Prompt-Hook-Shadow-2026-09-24',
          'PromptHookShadow',
          'Hook',
          'Shadow-Mode-Review',
          'Refund-Webhooks',
          'Stripe-Payouts'
        ],
        PROMPT
      )
    ).toEqual([
      { name: 'Hook', score: 1 },
      { name: 'Prompt-Hook-Shadow-2026-09-24', score: 1 },
      { name: 'PromptHookShadow', score: 1 },
      { name: 'Refund-Webhooks', score: 1 },
      { name: 'Shadow-Mode-Review', score: 2 / 3 }
    ])
  })

  it('needs two shared words unless the folder has only that one', () => {
    expect(rankProjectFolders(['Shadow-Mode-Review', 'Shadow'], 'shadow only')).toEqual([
      { name: 'Shadow', score: 1 }
    ])
  })
})

describe('mergePriorWorkCandidates', () => {
  const session = (ref: string, score: number): PriorWorkCandidate => ({
    kind: 'session',
    ref,
    title: ref,
    score
  })
  const folder = (ref: string, score: number): PriorWorkCandidate => ({
    kind: 'folder',
    ref,
    title: ref,
    score
  })

  it('keeps sessions in search order and fills the rest with folders, three at most', () => {
    expect(
      mergePriorWorkCandidates(
        [session('a', 12.5), session('b', 6.25)],
        [folder('x', 2 / 3), folder('y', 0.5)]
      )
    ).toEqual([session('a', 12.5), session('b', 6.25), folder('x', 0.667)])
  })

  it('returns folders alone when no session matched', () => {
    expect(mergePriorWorkCandidates([], [folder('x', 0.5)])).toEqual([folder('x', 0.5)])
  })
})

describe('PriorWorkShadow', () => {
  it("logs one record at a session's first prompt, without the session itself", async () => {
    const search = vi.fn(async () => ({
      hits: [
        hit('session-new', 'this session', 30),
        hit('old-1', 'Shadow hook design', 12),
        hit('old-2', 'Hook budget', 3.25)
      ]
    }))
    const shadow = makeShadow(search as never)

    observe(shadow, promptEvent(`  ${PROMPT}  `))

    await vi.waitFor(() => expect(sink.push).toHaveBeenCalledTimes(1))
    expect(search).toHaveBeenCalledWith('review prompt hook shadow', 6)
    const [record] = records()
    expect(record).toEqual({
      at: expect.any(Number),
      session_id: 'session-new',
      prompt_sha16: sha16(PROMPT),
      candidates: [
        { kind: 'session', ref: 'claude:old-1', title: 'Shadow hook design', score: 12 },
        { kind: 'session', ref: 'claude:old-2', title: 'Hook budget', score: 3.25 },
        {
          kind: 'folder',
          ref: join(projectsDirectory, 'Prompt-Hook-Shadow-2026-09-24'),
          title: 'Prompt-Hook-Shadow-2026-09-24',
          score: 1
        }
      ],
      latency_ms: expect.any(Number),
      agent: 'claude',
      sources: { sessions: 'ok', folders: 'ok', pages: 'none' }
    })
    expect(JSON.stringify(record)).not.toContain('Review the prompt')
  })

  it('ignores later prompts, replays, subagents, harness turns and non-prompt events', async () => {
    const shadow = makeShadow(vi.fn(async () => ({ hits: [] })) as never)

    observe(shadow, promptEvent('<task-notification>done</task-notification>'))
    observe(shadow, promptEvent(PROMPT, { isReplay: true }))
    observe(shadow, promptEvent(PROMPT, { toolAgentId: 'agent-1' }))
    observe(shadow, promptEvent(PROMPT, { hasExplicitPrompt: false }))
    observe(shadow, promptEvent(PROMPT, { hookEventName: 'PostToolUse' }))
    observe(shadow, promptEvent('the first real ask'))
    observe(shadow, promptEvent('a follow-up in the same session'))
    observe(shadow, promptEvent('another session', { providerSession: undefined }))

    await vi.waitFor(() => expect(sink.push).toHaveBeenCalledTimes(2))
    await settle()
    expect(records().map((record) => [record.session_id, record.prompt_sha16])).toEqual(
      expect.arrayContaining([
        ['session-new', sha16('the first real ask')],
        [null, sha16('another session')]
      ])
    )
    expect(sink.push).toHaveBeenCalledTimes(2)
  })

  it('skips the first prompt after a resume until the pane starts fresh', async () => {
    const shadow = makeShadow(vi.fn(async () => ({ hits: [] })) as never)

    observe(shadow, sessionStart('resume'))
    observe(shadow, promptEvent('continue the resumed work'))
    observe(shadow, sessionStart('clear'))
    observe(
      shadow,
      promptEvent('a fresh ask', { providerSession: { key: 'session_id', id: 'session-2' } })
    )

    await vi.waitFor(() => expect(sink.push).toHaveBeenCalledTimes(1))
    await settle()
    expect(records().map((record) => record.session_id)).toEqual(['session-2'])
  })

  it('logs gemini first prompts from BeforeAgent', async () => {
    const shadow = makeShadow(null)

    observe(shadow, promptEvent(PROMPT, { hookEventName: 'BeforeAgent' }), 'gemini')

    await vi.waitFor(() => expect(sink.push).toHaveBeenCalledTimes(1))
    expect(records()[0]).toMatchObject({ agent: 'gemini', sources: { sessions: 'unavailable' } })
  })

  it('does not search until the index is ready, and reports missing sources', async () => {
    const search = vi.fn()
    const shadow = makeShadow(null, {
      projectsDirectory: join(projectsDirectory, 'missing'),
      sessionSearch: () => ({ state: 'starting', search })
    })

    observe(shadow, promptEvent(PROMPT))

    await vi.waitFor(() => expect(sink.push).toHaveBeenCalledTimes(1))
    expect(search).not.toHaveBeenCalled()
    expect(records()[0]).toMatchObject({
      candidates: [],
      sources: { sessions: 'unavailable', folders: 'unavailable', pages: 'none' }
    })
  })

  it('records a failed search without throwing', async () => {
    const search = vi.fn(async () => {
      throw new Error('index gone')
    })
    const shadow = makeShadow(search as never)

    observe(shadow, promptEvent(PROMPT))

    await vi.waitFor(() => expect(sink.push).toHaveBeenCalledTimes(1))
    expect(records()[0].sources.sessions).toBe('failed')
    expect(records()[0].candidates.map((candidate) => candidate.kind)).toEqual(['folder', 'folder'])
  })

  it('spends only what is left of the 300 ms budget, then skips searches while one is stuck', async () => {
    let clock = 0
    const search = vi.fn(() => new Promise<never>(() => {}))
    const shadow = makeShadow(search as never, { now: () => clock })

    observe(shadow, promptEvent(PROMPT))
    // Why: the event waited 250 ms before its run started, so 50 ms of budget is left.
    clock = 250

    await vi.waitFor(() => expect(sink.push).toHaveBeenCalledTimes(1), { timeout: 2_000 })
    expect(records()[0]).toMatchObject({ latency_ms: 250, sources: { sessions: 'timeout' } })

    observe(
      shadow,
      promptEvent(PROMPT, { providerSession: { key: 'session_id', id: 'session-2' } })
    )
    await vi.waitFor(() => expect(sink.push).toHaveBeenCalledTimes(2))
    expect(records()[1].sources.sessions).toBe('busy')
    expect(search).toHaveBeenCalledTimes(1)
  })

  it('stops while the off file is in the logs directory', async () => {
    const offFile = join(logsDirectory, PRIOR_WORK_SHADOW_OFF_FILE)
    await writeFile(offFile, '')
    const search = vi.fn(async () => ({ hits: [] }))
    const shadow = makeShadow(search as never)

    observe(shadow, promptEvent(PROMPT))
    await settle(150)
    expect(sink.push).not.toHaveBeenCalled()
    expect(search).not.toHaveBeenCalled()

    await rm(offFile)
    observe(
      shadow,
      promptEvent(PROMPT, { providerSession: { key: 'session_id', id: 'session-2' } })
    )
    await vi.waitFor(() => expect(sink.push).toHaveBeenCalledTimes(1))
    expect(records()[0].session_id).toBe('session-2')
  })

  it('is not created when switched off at launch', () => {
    const deps = { logsDirectory, projectsDirectory, sessionSearch: () => null, sink }
    vi.stubEnv(PRIOR_WORK_SHADOW_DISABLED_ENV, '1')
    expect(createPriorWorkShadow(deps)).toBeNull()
    vi.stubEnv(PRIOR_WORK_SHADOW_DISABLED_ENV, '')
    expect(createPriorWorkShadow(deps)).toBeInstanceOf(PriorWorkShadow)
  })
})

describe('AgentHookServer with the prior-work shadow', () => {
  let server: AgentHookServer

  beforeEach(async () => {
    _internals.resetCachesForTests()
    server = new AgentHookServer()
    await server.start({ env: 'production' })
  })

  afterEach(() => {
    server.stop()
    vi.restoreAllMocks()
  })

  it('answers the first prompt with an empty 204 before the shadow search finishes', async () => {
    let finish: (value: { hits: SessionSearchHit[] }) => void = () => {}
    const search = vi.fn(
      () =>
        new Promise<{ hits: SessionSearchHit[] }>((resolve) => {
          finish = resolve
        })
    )
    server.setPriorWorkShadow(makeShadow(search as never))
    const prompt = 'fix the prompt hook shadow budget'

    const response = await postHookEvent(
      server,
      buildBody(
        { hook_event_name: 'UserPromptSubmit', prompt, session_id: 'claude-session-1' },
        { launchToken: 'launch-1' }
      )
    )

    expect(response.status).toBe(204)
    expect(await response.text()).toBe('')
    expect(sink.push).not.toHaveBeenCalled()
    expect(server.getStatusSnapshotForPane(PANE)).toEqual([expect.objectContaining({ prompt })])
    await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(1))
    finish({ hits: [hit('old-1', 'Prompt hook budget', 9)] })
    await vi.waitFor(() => expect(sink.push).toHaveBeenCalledTimes(1))
    expect(records()[0]).toMatchObject({
      session_id: 'claude-session-1',
      prompt_sha16: sha16(prompt),
      agent: 'claude'
    })
  })
})
