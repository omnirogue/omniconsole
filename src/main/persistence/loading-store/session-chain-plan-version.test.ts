import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PersistedState } from '../../../shared/persisted-state-types'
import {
  SESSION_CHAIN_SCHEMA_VERSION,
  normalizeSessionChainsWithReport,
  type SessionChain
} from '../../../shared/session-chain-types'
import { reviseSessionOutcomeSet } from '../../../shared/session-outcome-state'
import { sessionOutcomeConditionKey } from '../../../shared/session-outcome-types'
import { writeFileDurableSync } from '../../durable-file-write'
import { SessionChainPersistence } from './session-chain-persistence'
import type { WriteSchedulingOperations } from './write-scheduling'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))

const condition = { id: 'report', kind: 'file', target: 'report.md' } as const
const taskRef = {
  taskId: 'btk_abcd1234',
  attachedAt: 7,
  attachedBy: 'emp_sal',
  postedNoteId: 'note_1',
  postedAt: 8
}

/** A set carrying every record the plan-version fields ride on: filing, attempt, receipt. */
const outcomeSet = () => {
  const base = reviseSessionOutcomeSet(
    undefined,
    {
      expectedRevision: 0,
      source: 'user',
      outcomes: [
        {
          id: 'report',
          title: 'The report',
          finish: 'complete',
          dependsOn: [],
          stepIds: ['s1', 's2'],
          actions: [],
          conditions: [condition]
        }
      ],
      taskRef
    },
    { owner: 'execution-host', hostId: 'local', epoch: 'epoch', state: 'owned' },
    1
  )
  return {
    ...base,
    outcomes: [
      {
        ...base.outcomes[0]!,
        evidence: [
          {
            id: 'ev_report',
            outcomeId: 'report',
            conditionId: 'report',
            outcomeRevision: 1,
            conditionKey: sessionOutcomeConditionKey(condition),
            kind: condition.kind,
            target: condition.target,
            receipt: 'sha256:deadbeef:/w/report.md',
            verifiedAt: 2,
            verifier: 'execution-host' as const,
            planVersion: 1
          }
        ]
      }
    ],
    attempts: [
      {
        id: 'att_s1',
        outcomeId: 'report',
        actionId: 'step_s1',
        actionKey: 'key',
        outcomeRevision: 1,
        state: 'superseded' as const,
        planVersion: 1,
        startedAt: 1,
        updatedAt: 2
      }
    ]
  }
}

const planChain = (): SessionChain =>
  ({
    id: 'chn_plan',
    workspacePath: '/Users/me/Webinar',
    worktreeId: 'folder:f1',
    hostId: 'local',
    sourcePaneKey: 'tab-1:leaf-1',
    sourceRowKey: 'row',
    auto: false,
    steps: [
      { id: 's1', agent: 'claude', prompt: 'v1 seat', status: 'skipped', planVersion: 1 },
      {
        id: 's2',
        agent: 'claude',
        prompt: 'v2 seat',
        status: 'queued',
        planNodeId: 'node_write',
        planVersion: 2
      }
    ],
    outcomeSet: outcomeSet(),
    planVersion: 2,
    planVersions: [
      { version: 1, at: 1 },
      { version: 2, supersedes: 1, reason: 'The review route was wrong.', at: 5 }
    ],
    currentIndex: 1,
    state: 'waiting',
    schemaVersion: SESSION_CHAIN_SCHEMA_VERSION,
    createdAt: 1,
    updatedAt: 2
  }) as unknown as SessionChain

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'plan-version-'))
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
  return { store, state, reload }
}

describe('plan versions and the card filing survive the host', () => {
  it('writes every version field to disk and reads it back unchanged', () => {
    const { store, reload } = fixture()
    const saved = store.replaceSessionChainOutcomesAndFlush(planChain(), 0)
    const { chains, unloadable } = reload()
    expect(unloadable).toEqual([])
    expect(chains[0]).toEqual(saved)
    // Why spelled out: a save that dropped a field on both sides would still deep-equal.
    expect(chains[0]?.planVersion).toBe(2)
    expect(chains[0]?.planVersions).toEqual([
      { version: 1, at: 1 },
      { version: 2, supersedes: 1, reason: 'The review route was wrong.', at: 5 }
    ])
    expect(chains[0]?.steps.map((step) => (step as { planVersion?: number }).planVersion)).toEqual([
      1, 2
    ])
    expect(chains[0]?.outcomeSet?.outcomes[0]?.taskRef).toEqual(taskRef)
    expect(chains[0]?.outcomeSet?.outcomes[0]?.evidence[0]?.planVersion).toBe(1)
    expect(chains[0]?.outcomeSet?.attempts[0]).toMatchObject({
      state: 'superseded',
      planVersion: 1
    })
  })

  it('still has them after the host saves the chain it just read', () => {
    const { store, reload } = fixture()
    store.replaceSessionChainOutcomesAndFlush(planChain(), 0)
    const afterFirst = reload().chains[0]!
    const ticked = store.replaceSessionChainOutcomesAndFlush(
      { ...afterFirst, outcomeSet: { ...afterFirst.outcomeSet!, revision: 2 } },
      1
    )
    const afterTick = reload().chains[0]!
    expect(afterTick).toEqual(ticked)
    expect(afterTick.planVersion).toBe(2)
    expect(afterTick.planVersions).toHaveLength(2)
    expect(afterTick.outcomeSet?.outcomes[0]?.taskRef).toEqual(taskRef)
    expect(afterTick.outcomeSet?.attempts[0]?.state).toBe('superseded')
    expect(afterTick.steps[1]).toMatchObject({ planVersion: 2, planNodeId: 'node_write' })
  })

  it('never writes the card into the continuation', () => {
    const { store, reload } = fixture()
    store.replaceSessionChainOutcomesAndFlush(planChain(), 0)
    const continuation = reload().chains[0]!.outcomeSet!.continuation
    expect('taskRef' in continuation).toBe(false)
    expect(JSON.stringify(continuation)).not.toContain(taskRef.taskId)
  })

  it('marks a chain that only files a card as a version-2 record', () => {
    // Why this shape: no seat field, no verdict, no plan version — the filing is the only thing
    // about this record a build older than it cannot read.
    const plain = {
      ...planChain(),
      steps: [
        { id: 's1', agent: 'claude', prompt: 'v1 seat', status: 'queued' },
        { id: 's2', agent: 'claude', prompt: 'v2 seat', status: 'queued' }
      ],
      planVersion: undefined,
      planVersions: undefined,
      schemaVersion: undefined,
      outcomeSet: {
        ...outcomeSet(),
        attempts: [],
        outcomes: [{ ...outcomeSet().outcomes[0]!, evidence: [] }]
      }
    } as unknown as SessionChain
    const { chains, unloadable } = normalizeSessionChainsWithReport([plain])
    expect(unloadable).toEqual([])
    expect(chains[0]?.outcomeSet?.outcomes[0]?.taskRef?.taskId).toBe('btk_abcd1234')
    expect(chains[0]?.schemaVersion).toBe(SESSION_CHAIN_SCHEMA_VERSION)
  })

  it('refuses a version it cannot read instead of dropping the plan', () => {
    const report = normalizeSessionChainsWithReport([{ ...planChain(), planVersion: 0 }])
    expect(report.unloadable[0]).toMatchObject({ id: 'chn_plan', reason: 'invalid-step' })
    expect(report.chains[0]?.quarantine?.record).toMatchObject({ planVersion: 0 })
    const history = normalizeSessionChainsWithReport([
      { ...planChain(), planVersions: [{ version: 2, at: 5, note: 'from a newer build' }] }
    ])
    expect(history.unloadable[0]?.detail).toContain('version history')
    expect(history.chains[0]?.quarantine?.record).toBeTruthy()
  })
})
