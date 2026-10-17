import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { SESSION_CHAIN_LAUNCH_RECEIPT_SCHEMA_VERSION } from '../../../shared/session-chain-normalize'
import {
  SESSION_CHAIN_SCHEMA_VERSION,
  normalizeSessionChainsWithReport,
  type SessionChain
} from '../../../shared/session-chain-types'
import { reviseSessionOutcomeSet } from '../../../shared/session-outcome-state'
import { writeFileDurableSync } from '../../durable-file-write'
import { SessionChainPersistence } from './session-chain-persistence'
import type { WriteSchedulingOperations } from './write-scheduling'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))

const outcomeSet = (stepIds: string[]) =>
  reviseSessionOutcomeSet(
    undefined,
    {
      expectedRevision: 0,
      source: 'user',
      outcomes: [
        {
          id: 'plan',
          title: 'Plan the webinar',
          finish: 'complete',
          outputKind: 'plan',
          dependsOn: [],
          stepIds,
          actions: [],
          conditions: [{ id: 'plan_file', kind: 'file', target: 'plan.json' }]
        }
      ]
    },
    { owner: 'execution-host', hostId: 'local', epoch: 'epoch', state: 'owned' },
    1
  )

const seat = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  agent: 'claude',
  prompt: `work on ${id}`,
  status: 'queued',
  ...extra
})

const workPlanChain = (): SessionChain =>
  ({
    id: 'chn_plan',
    workspacePath: '/Users/me/Webinar',
    worktreeId: 'folder:f1',
    hostId: 'local',
    sourcePaneKey: 'tab-1:leaf-1',
    sourceRowKey: 'row',
    auto: true,
    steps: [
      seat('s1', {
        group: 'g1',
        seat: { index: 1, total: 2 },
        planNodeId: 'node_research',
        route: 'new-session',
        writes: 'own-output-dir',
        wait: { reason: 'capacity', since: 1700 }
      }),
      seat('s2', { group: 'g1', seat: { index: 2, total: 2 }, planNodeId: 'node_research' }),
      seat('s3', {
        verdict: { kind: 'judge', over: ['s1', 's2'], consumed: 'select-winner' },
        enabledBy: { verdict: 'v_research', seatsOf: 'node_research' },
        readsWinnerOf: 'node_research',
        readsFrom: ['s1', 's2']
      })
    ],
    outcomeSet: outcomeSet(['s1', 's2', 's3']),
    verdicts: [
      {
        stepId: 's3',
        attemptId: 'att_1',
        verdict: { status: 'pass', winner: 's2' },
        consumptionKey: 'node_research:judge:1',
        consumedAt: 1800
      }
    ],
    currentIndex: 0,
    state: 'waiting',
    schemaVersion: SESSION_CHAIN_SCHEMA_VERSION,
    createdAt: 1,
    updatedAt: 2
  }) as unknown as SessionChain

/** The shape the Next-step UI allows today: five reviewers over five rounds, each with a repair. */
const reviewLadderChain = (): SessionChain => {
  const steps: Record<string, unknown>[] = [seat('producer')]
  for (let round = 1; round <= 5; round += 1) {
    for (let reviewer = 1; reviewer <= 5; reviewer += 1) {
      steps.push(
        seat(`review_${round}_${reviewer}`, {
          group: `g1_round_${round}`,
          review: {
            groupId: 'g1',
            reviewerId: `rev_${reviewer}`,
            round,
            maxRounds: 5,
            candidateVersion: 'v1'
          }
        })
      )
    }
    steps.push(
      seat(`repair_${round}`, {
        reviewRepair: {
          groupId: 'g1',
          afterRound: round,
          candidateVersion: 'v1',
          consumptionKey: `g1:repair:${round}:v1`
        }
      })
    )
  }
  return {
    ...workPlanChain(),
    id: 'chn_ladder',
    steps,
    verdicts: undefined,
    schemaVersion: undefined,
    outcomeSet: outcomeSet(steps.map((step) => step.id as string))
  } as unknown as SessionChain
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'chain-contract-'))
  dirs.push(dir)
  const path = join(dir, 'state.json')
  const state = { sessionChains: [] } as unknown as PersistedState
  const runtime = {
    state,
    writesFrozen: false,
    flushOrThrow: () => writeFileDurableSync(join(dir, 'state.tmp'), path, JSON.stringify(state))
  }
  const store = new SessionChainPersistence(runtime, {} as WriteSchedulingOperations)
  const reload = () =>
    normalizeSessionChainsWithReport(
      (JSON.parse(readFileSync(path, 'utf8')) as PersistedState).sessionChains
    )
  return { store, runtime, state, path, reload }
}

describe('the persistence contract for work-plan chains', () => {
  it('writes every work-plan field to disk and reads it back unchanged', () => {
    const { store, reload } = fixture()
    const saved = store.replaceSessionChainOutcomesAndFlush(workPlanChain(), 0)
    const { chains, unloadable } = reload()
    expect(unloadable).toEqual([])
    expect(chains[0]).toEqual(saved)
    // Why spelled out: a save that dropped a field on both sides would still deep-equal.
    expect(chains[0]?.steps[0]).toMatchObject({
      seat: { index: 1, total: 2 },
      wait: { reason: 'capacity', since: 1700 },
      route: 'new-session',
      writes: 'own-output-dir',
      planNodeId: 'node_research'
    })
    expect(chains[0]?.steps[2]).toMatchObject({
      verdict: { kind: 'judge', over: ['s1', 's2'], consumed: 'select-winner' },
      enabledBy: { verdict: 'v_research', seatsOf: 'node_research' },
      readsWinnerOf: 'node_research',
      readsFrom: ['s1', 's2']
    })
    expect(chains[0]?.verdicts?.[0]?.consumptionKey).toBe('node_research:judge:1')
    expect(chains[0]?.outcomeSet?.outcomes[0]?.outputKind).toBe('plan')
    expect(chains[0]?.schemaVersion).toBe(SESSION_CHAIN_SCHEMA_VERSION)
  })

  it('keeps a record it refused on disk across a save of other work', () => {
    const { store, state, reload } = fixture()
    const fromTheFuture = {
      ...workPlanChain(),
      schemaVersion: SESSION_CHAIN_LAUNCH_RECEIPT_SCHEMA_VERSION + 1
    }
    const loaded = normalizeSessionChainsWithReport([fromTheFuture])
    expect(loaded.unloadable[0]).toMatchObject({ id: 'chn_plan', reason: 'newer-schema' })
    state.sessionChains = loaded.chains
    store.replaceSessionChainOutcomesAndFlush({ ...workPlanChain(), id: 'chn_other' }, 0)
    const after = reload()
    expect(after.chains.map((chain) => chain.id)).toEqual(['chn_plan', 'chn_other'])
    expect(after.chains[0]?.quarantine?.record).toEqual(fromTheFuture)
    expect(after.unloadable).toEqual([
      { id: 'chn_plan', reason: 'newer-schema', detail: loaded.unloadable[0]!.detail }
    ])
  })

  it('never lets a client overwrite the only copy of a refused record', () => {
    const { store, state } = fixture()
    state.sessionChains = normalizeSessionChainsWithReport([
      { ...workPlanChain(), schemaVersion: SESSION_CHAIN_LAUNCH_RECEIPT_SCHEMA_VERSION + 1 }
    ]).chains
    expect(() => store.upsertSessionChain({ ...workPlanChain(), outcomeSet: undefined })).toThrow(
      'cannot be overwritten'
    )
    expect(() => store.replaceSessionChainOutcomesAndFlush(workPlanChain(), 0)).toThrow(
      'cannot be overwritten'
    )
    expect(store.listSessionChains()[0]?.quarantine?.reason).toBe('newer-schema')
  })

  it('refuses a plan that outgrew the stage or the seat cap on the write that commits it', () => {
    const { store } = fixture()
    const deep = Array.from({ length: 7 }, (_, index) => seat(`deep_${index}`))
    expect(() =>
      store.replaceSessionChainOutcomesAndFlush(
        {
          ...workPlanChain(),
          steps: deep,
          verdicts: undefined,
          outcomeSet: outcomeSet(deep.map((step) => step.id))
        } as unknown as SessionChain,
        0
      )
    ).toThrow('up to 6 stages')
    const wide = Array.from({ length: 25 }, (_, index) => seat(`wide_${index}`, { group: 'g1' }))
    expect(() =>
      store.replaceSessionChainOutcomesAndFlush(
        {
          ...workPlanChain(),
          steps: wide,
          verdicts: undefined,
          outcomeSet: outcomeSet(wide.map((step) => step.id))
        } as unknown as SessionChain,
        0
      )
    ).toThrow('up to 24 agents')
    expect(store.listSessionChains()).toEqual([])
  })

  it('never refuses a review ladder the composer already allows, or a save of work in flight', () => {
    const { store, state, reload } = fixture()
    const ladder = reviewLadderChain()
    const saved = store.replaceSessionChainOutcomesAndFlush(ladder, 0)
    expect(saved.steps).toHaveLength(31)
    expect(reload().unloadable).toEqual([])
    // A plan committed before the caps existed keeps recording what it already ran.
    const oversized = {
      ...workPlanChain(),
      steps: Array.from({ length: 7 }, (_, index) => seat(`deep_${index}`)),
      verdicts: undefined
    } as unknown as SessionChain
    state.sessionChains = [
      { ...oversized, outcomeSet: outcomeSet(oversized.steps.map((step) => step.id)) }
    ]
    expect(() =>
      store.replaceSessionChainOutcomesAndFlush(
        { ...oversized, outcomeSet: outcomeSet(oversized.steps.map((step) => step.id)) },
        1
      )
    ).not.toThrow()
  })
})
