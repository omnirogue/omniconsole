import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { normalizeSessionChain, type SessionChain } from '../../../shared/session-chain-types'
import { reviseSessionOutcomeSet } from '../../../shared/session-outcome-state'
import { writeFileDurableSync } from '../../durable-file-write'
import { SessionChainPersistence } from './session-chain-persistence'
import type { WriteSchedulingOperations } from './write-scheduling'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))
const outcomeSet = () =>
  reviseSessionOutcomeSet(
    undefined,
    {
      expectedRevision: 0,
      source: 'user',
      outcomes: [
        {
          id: 'report',
          title: 'Report',
          finish: 'complete',
          dependsOn: [],
          actions: [],
          conditions: [{ id: 'file', kind: 'file', target: '/report.md' }]
        }
      ]
    },
    { owner: 'execution-host', hostId: 'local', epoch: 'epoch', state: 'owned' },
    1
  )
const chain = (): SessionChain =>
  normalizeSessionChain({
    id: 'chain',
    workspacePath: '/work',
    worktreeId: 'folder:work',
    sourcePaneKey: 'pane',
    sourceRowKey: 'row',
    steps: [],
    outcomeSet: outcomeSet()
  })!

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'outcome-store-'))
  dirs.push(dir)
  const path = join(dir, 'state.json')
  const state = { sessionChains: [] } as unknown as PersistedState
  let fail = false
  const runtime = {
    state,
    writesFrozen: false,
    flushOrThrow: () => {
      if (fail) {
        throw new Error('disk full')
      }
      writeFileDurableSync(join(dir, 'state.tmp'), path, JSON.stringify(state))
    }
  }
  const store = new SessionChainPersistence(runtime, {} as WriteSchedulingOperations)
  return {
    store,
    runtime,
    path,
    fail: () => {
      fail = true
    }
  }
}

describe('durable atomic outcome persistence', () => {
  it('returns only after the actual profile file contains the complete set and owner', () => {
    const { store, path } = fixture()
    const saved = store.replaceSessionChainOutcomesAndFlush(chain(), 0)
    expect(JSON.parse(readFileSync(path, 'utf8')).sessionChains[0].outcomeSet).toEqual(
      saved.outcomeSet
    )
    expect(saved.outcomeSet?.continuation.state).toBe('owned')
  })
  it('rolls memory back and retains the durable prior revision on write failure', () => {
    const f = fixture(),
      saved = f.store.replaceSessionChainOutcomesAndFlush(chain(), 0)
    const disk = readFileSync(f.path, 'utf8')
    f.fail()
    expect(() =>
      f.store.replaceSessionChainOutcomesAndFlush(
        { ...saved, outcomeSet: { ...saved.outcomeSet!, revision: 2 } },
        1
      )
    ).toThrow('disk full')
    expect(f.store.listSessionChains()).toEqual([saved])
    expect(readFileSync(f.path, 'utf8')).toBe(disk)
  })
  it('rejects stale concurrent saves and freezes, and gives callers isolated snapshots', () => {
    const f = fixture(),
      saved = f.store.replaceSessionChainOutcomesAndFlush(chain(), 0)
    f.store.replaceSessionChainOutcomesAndFlush(
      { ...saved, outcomeSet: { ...saved.outcomeSet!, revision: 2 } },
      1
    )
    expect(() => f.store.replaceSessionChainOutcomesAndFlush(saved, 1)).toThrow('conflict')
    // Why a throw: readers share one frozen snapshot, so a write through it fails loudly instead.
    const copy = f.store.listSessionChains()
    expect(() => {
      copy[0]!.outcomeSet!.outcomes[0]!.title = 'mutated'
    }).toThrow(TypeError)
    expect(f.store.listSessionChains()[0]!.outcomeSet!.outcomes[0]!.title).toBe('Report')
    f.runtime.writesFrozen = true
    expect(() => f.store.replaceSessionChainOutcomesAndFlush(saved, 2)).toThrow('unavailable')
  })
  it('protects committed obligations from older client upserts and removals', () => {
    const f = fixture(),
      saved = f.store.replaceSessionChainOutcomesAndFlush(chain(), 0)
    expect(() =>
      f.store.upsertSessionChain({ ...saved, outcomeSet: undefined, end: 'done' })
    ).toThrow('atomic outcome API')
    expect(() => f.store.removeSessionChain(saved.id)).toThrow('explicitly revised')
    expect(f.store.listSessionChains()).toEqual([saved])
  })
})
