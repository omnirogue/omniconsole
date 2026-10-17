import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { outcomeRuntimeFixture } from './session-outcome-runtime-test-fixture'
import { SessionOutcomeService } from './session-outcome-service'
import { sessionOutcomeProgress } from '../../shared/session-outcome-state'
import {
  sessionOutcomeActionKey,
  type SessionOutcomeDefinition
} from '../../shared/session-outcome-types'

const fixtures: ReturnType<typeof outcomeRuntimeFixture>[] = []
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.dispose()
  }
})
function fixture() {
  const f = outcomeRuntimeFixture((_spec, workspace) => {
    writeFileSync(join(workspace, 'result.txt'), 'result')
    return { body: 'Produced result' }
  })
  fixtures.push(f)
  return f
}
const chain = (workspace: string) => ({
  id: 'chain',
  workspacePath: workspace,
  worktreeId: 'folder:outcome',
  hostId: 'local',
  sourcePaneKey: 'source',
  sourceRowKey: 'row',
  auto: true,
  steps: [],
  currentIndex: 0,
  state: 'waiting',
  createdAt: 1,
  updatedAt: 1
})
const definition = (workspace: string): SessionOutcomeDefinition => ({
  id: 'outcome',
  title: 'Result',
  finish: 'complete',
  dependsOn: [],
  conditions: [{ id: 'file', kind: 'file', target: join(workspace, 'result.txt') }],
  actions: [
    {
      id: 'produce',
      instruction: 'Produce result',
      authority: 'existing-user-authority',
      agent: 'codex',
      conditionIds: ['file']
    }
  ]
})
async function drain(f: ReturnType<typeof fixture>) {
  for (let index = 0; index < 5; index++) {
    await f.service.tick()
    await f.settle()
  }
}

describe('outcome revision, source recovery, human review and retry resolution', () => {
  it('captures completed source authority during commit and continues after its pane disappears', async () => {
    const f = fixture()
    const saved = await f.service.commit(chain(f.workspace), {
      expectedRevision: 0,
      source: 'user',
      outcomes: [definition(f.workspace)]
    })
    f.service.dispose()
    expect(saved.outcomeSet!.continuation.sourceReady).toBe(true)
    vi.mocked(f.runtime.resolveTerminalPane).mockImplementation(() => {
      throw new Error('gone')
    })
    await drain(f)
    expect(sessionOutcomeProgress(f.service.get('chain').outcomeSet!).lifecycle).toBe('complete')
    expect(f.launched).toHaveLength(1)
  })
  it('keeps an unverifiable lost source visible and never treats missing contact as exit', async () => {
    const f = fixture()
    vi.mocked(f.runtime.resolveTerminalPane).mockImplementation(() => {
      throw new Error('unreachable')
    })
    await f.service.commit(chain(f.workspace), {
      expectedRevision: 0,
      source: 'user',
      outcomes: [definition(f.workspace)]
    })
    f.service.dispose()
    await f.service.tick()
    const progress = sessionOutcomeProgress(f.service.get('chain').outcomeSet!)
    expect(progress.reasons.join(' ')).toContain('unverifiable')
    // A source pane that is gone for good is an honest failure of this run, never a request.
    expect(progress).toMatchObject({ phase: 'failed', lifecycle: 'waiting', attention: [] })
    expect(f.service.get('chain').outcomeSet!.outcomes[0]!.block).toMatchObject({
      class: 'failed',
      code: 'source-gone'
    })
    expect(f.launched).toHaveLength(0)
  })
  it('reconstructs the service after partial durable execution without relaunching completed actions', async () => {
    const f = fixture()
    await f.service.commit(chain(f.workspace), {
      expectedRevision: 0,
      source: 'user',
      outcomes: [definition(f.workspace)]
    })
    f.service.dispose()
    await drain(f)
    await f.service.suspend()
    const restored = new SessionOutcomeService(f.runtime)
    await restored.tick()
    await restored.tick()
    await restored.suspend()
    expect(f.launched).toHaveLength(1)
    expect(sessionOutcomeProgress(restored.get('chain').outcomeSet!).lifecycle).toBe('complete')
  })
  it('adds a new outcome with ordered work to a complete run as a new generation and retains the first receipt', async () => {
    const f = fixture()
    await f.service.commit(chain(f.workspace), {
      expectedRevision: 0,
      source: 'user',
      outcomes: [definition(f.workspace)]
    })
    f.service.dispose()
    await drain(f)
    const old = f.service.get('chain'),
      firstReceipt = old.outcomeSet!.outcomes[0]!.evidence[0]!.id
    const step = {
      id: 'new_step',
      outcomeId: 'second',
      agent: 'codex' as const,
      prompt: 'Produce second result',
      status: 'queued' as const
    }
    // Why stubbed: the fork's own startup pass would run unawaited while these ticks skip its lane.
    vi.spyOn(f.service, 'start').mockImplementation(() => {})
    // Why only the new outcome: the finished run is sealed, so a later Outcome is a new generation
    // of the same source. Restating the proven outcome beside it would be new work to run again.
    const saved = await f.service.commit(
      { ...old, steps: [step] },
      {
        expectedRevision: 1,
        source: 'user',
        outcomes: [
          {
            ...definition(f.workspace),
            id: 'second',
            title: 'Second',
            stepIds: ['new_step'],
            actions: []
          }
        ]
      }
    )
    f.service.dispose()
    expect(saved.id).toMatch(/^source_[a-f0-9]{40}$/)
    expect(saved.steps.map((entry) => entry.id)).toEqual(['new_step'])
    expect(sessionOutcomeProgress(saved.outcomeSet!)).toMatchObject({
      phase: 'active',
      lifecycle: 'waiting',
      attention: []
    })
    await drain(f)
    expect(sessionOutcomeProgress(f.service.get(saved.id).outcomeSet!)).toMatchObject({
      phase: 'completed',
      lifecycle: 'complete'
    })
    // The sealed run is exactly what it was: still complete, its first receipt untouched.
    const sealed = f.service.get('chain').outcomeSet!
    expect(sealed.completion).toEqual(old.outcomeSet!.completion)
    expect(sessionOutcomeProgress(sealed).lifecycle).toBe('complete')
    expect(sealed.outcomes[0]!.evidence[0]!.id).toBe(firstReceipt)
    expect(f.launched).toHaveLength(2)
  })
  it('allows a user retry only after a persisted pre-launch failure proves no worker started', async () => {
    const f = fixture()
    await f.service.commit(chain(f.workspace), {
      expectedRevision: 0,
      source: 'user',
      outcomes: [definition(f.workspace)]
    })
    f.service.dispose()
    const saved = f.service.get('chain'),
      action = saved.outcomeSet!.outcomes[0]!.actions[0]!
    f.service.save(
      {
        ...saved,
        outcomeSet: {
          ...saved.outcomeSet!,
          attempts: [
            {
              id: 'failed_prepare',
              actionId: action.id,
              actionKey: sessionOutcomeActionKey(action),
              outcomeId: 'outcome',
              outcomeRevision: 1,
              state: 'blocked',
              launchDisposition: 'not-started',
              error: 'Account unavailable before launch',
              startedAt: 1,
              updatedAt: 1
            }
          ]
        }
      },
      1
    )
    await f.service.resume('chain', 1)
    await drain(f)
    expect(f.launched).toHaveLength(1)
    expect(sessionOutcomeProgress(f.service.get('chain').outcomeSet!).lifecycle).toBe('complete')
    expect(f.service.get('chain').outcomeSet!.attempts).toHaveLength(2)
  })
  it('reconciles a completed external effect from actual proof without replaying an uncertain dispatch', async () => {
    const f = fixture()
    await f.service.commit(chain(f.workspace), {
      expectedRevision: 0,
      source: 'user',
      outcomes: [definition(f.workspace)]
    })
    f.service.dispose()
    const saved = f.service.get('chain'),
      action = saved.outcomeSet!.outcomes[0]!.actions[0]!
    f.service.save(
      {
        ...saved,
        outcomeSet: {
          ...saved.outcomeSet!,
          attempts: [
            {
              id: 'lost_receipt',
              actionId: action.id,
              actionKey: sessionOutcomeActionKey(action),
              outcomeId: 'outcome',
              outcomeRevision: 1,
              state: 'unverifiable',
              error: 'Response lost',
              startedAt: 1,
              updatedAt: 1
            }
          ]
        }
      },
      1
    )
    await f.service.resume('chain', 1)
    expect(f.launched).toHaveLength(0)
    expect(sessionOutcomeProgress(f.service.get('chain').outcomeSet!).lifecycle).not.toBe(
      'complete'
    )
    f.write('result.txt', 'actual result')
    await f.service.resume('chain', 1)
    expect(sessionOutcomeProgress(f.service.get('chain').outcomeSet!).lifecycle).toBe('complete')
    expect(f.launched).toHaveLength(0)
  })
  it('binds human review to actual bytes and invalidates only the changed outcome approval', async () => {
    const f = fixture()
    f.write('result.txt', 'version 1')
    f.write('other.txt', 'unchanged')
    await f.service.commit(chain(f.workspace), {
      expectedRevision: 0,
      source: 'user',
      outcomes: [
        {
          ...definition(f.workspace),
          finish: 'my-review',
          actions: [],
          conditions: [
            { id: 'file', kind: 'file', target: join(f.workspace, 'result.txt') },
            { id: 'review', kind: 'review', target: 'result' }
          ]
        },
        {
          ...definition(f.workspace),
          id: 'other',
          finish: 'my-review',
          actions: [],
          conditions: [
            { id: 'file', kind: 'file', target: join(f.workspace, 'other.txt') },
            { id: 'review', kind: 'review', target: 'other' }
          ]
        },
        // Why a third obligation nobody delivers: two approvals would otherwise seal the run, and
        // a sealed run is final — drifted bytes cannot invalidate anything in it any more.
        {
          ...definition(f.workspace),
          id: 'undelivered',
          title: 'Never delivered',
          actions: [],
          conditions: [{ id: 'file', kind: 'file', target: join(f.workspace, 'never.txt') }]
        }
      ]
    })
    f.service.dispose()
    await f.service.tick()
    const set = () => f.service.get('chain').outcomeSet!
    const reviewOf = (outcomeId: string) =>
      set()
        .outcomes.find((entry) => entry.id === outcomeId)!
        .conditions.find((entry) => entry.kind === 'review')!
    const asks = () =>
      sessionOutcomeProgress(set()).attention.map((entry) => [entry.kind, entry.scope.outcomeId])
    const initial = reviewOf('outcome').version!
    const otherVersion = reviewOf('other').version!
    // The owner's own review asks nothing: each outcome is satisfied under the version it holds.
    expect(sessionOutcomeProgress(set()).phase).not.toBe('needs-you')
    expect(asks()).toEqual([])
    // An explicit approval of the exact bytes is still recordable on top of that.
    await f.service.review('chain', 1, 'other', 'review', otherVersion)
    await f.service.review('chain', 1, 'outcome', 'review', initial)
    expect(set().outcomes.map((entry) => [entry.id, entry.status])).toEqual([
      ['outcome', 'satisfied'],
      ['other', 'satisfied'],
      ['undelivered', expect.not.stringMatching('satisfied')]
    ])
    expect(sessionOutcomeProgress(set())).toMatchObject({ satisfied: 2, total: 3, attention: [] })
    expect(sessionOutcomeProgress(set()).phase).not.toBe('needs-you')
    f.write('result.txt', 'version 2')
    await expect(f.service.review('chain', 1, 'outcome', 'review', initial)).rejects.toThrow(
      'version'
    )
    for (let index = 0; index < 3; index++) {
      await f.service.tick()
    }
    // The changed bytes are a new version of the changed outcome only — still nobody's question.
    const progress = sessionOutcomeProgress(set())
    expect(progress.phase).not.toBe('needs-you')
    expect(progress.attention).toEqual([])
    expect(reviewOf('outcome').version).not.toBe(initial)
    await expect(f.service.review('chain', 1, 'outcome', 'review', initial)).rejects.toThrow(
      'version'
    )
    expect(set().evidenceHistory!.length).toBeGreaterThan(0)
    expect(set().outcomes[1]!.status).toBe('satisfied')
    expect(reviewOf('other').version).toBe(otherVersion)
  })
})
