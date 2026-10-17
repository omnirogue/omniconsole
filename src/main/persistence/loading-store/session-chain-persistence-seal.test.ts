import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PersistedState } from '../../../shared/persisted-state-types'
import {
  normalizeSessionChainsWithReport,
  type SessionChain
} from '../../../shared/session-chain-types'
import type { SessionOutcomeSet } from '../../../shared/session-outcome-types'
import {
  recordSessionRunDisposition,
  sealSessionRunCompletion
} from '../../../shared/session-run-completion'
import { proveRun, runSet } from '../../../shared/session-run-lifecycle.test-fixture'
import { writeFileDurableSync } from '../../durable-file-write'
import { SessionChainPersistence } from './session-chain-persistence'
import type { WriteSchedulingOperations } from './write-scheduling'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'chain-seal-'))
  dirs.push(dir)
  const path = join(dir, 'state.json')
  const state = { sessionChains: [] } as unknown as PersistedState
  const store = new SessionChainPersistence(
    {
      state,
      writesFrozen: false,
      flushOrThrow: () => writeFileDurableSync(join(dir, 'state.tmp'), path, JSON.stringify(state))
    },
    {} as WriteSchedulingOperations
  )
  const reload = () =>
    normalizeSessionChainsWithReport(
      (JSON.parse(readFileSync(path, 'utf8')) as PersistedState).sessionChains
    )
  return { store, reload }
}

const chain = (outcomeSet: SessionOutcomeSet, state: SessionChain['state']): SessionChain => ({
  id: 'chn_1',
  workspacePath: '/w',
  worktreeId: 'folder:f1',
  hostId: 'local',
  sourcePaneKey: 'tab-1:leaf-1',
  sourceRowKey: 'row',
  auto: true,
  steps: [],
  currentIndex: 0,
  state,
  outcomeSet,
  createdAt: 1,
  updatedAt: 2
})

const sealedSet = (): SessionOutcomeSet =>
  sealSessionRunCompletion(
    { ...proveRun(runSet(), 'one'), sessionFinish: { action: 'save', folderId: 'folder-7' } },
    { now: 100, operationId: 'op_seal' }
  )

describe('the durable door and a sealed run', () => {
  it('writes the seal and the disposition to disk and reads them back unchanged', () => {
    const { store, reload } = fixture()
    const saved = store.replaceSessionChainOutcomesAndFlush(chain(sealedSet(), 'done'), 0)
    const { chains, unloadable } = reload()
    expect(unloadable).toEqual([])
    expect(chains[0]).toEqual(saved)
    expect(chains[0]!.outcomeSet).toMatchObject({
      completion: { at: 100, outcomes: [{ id: 'one', revision: 1 }], evidenceIds: ['receipt_one'] },
      disposition: {
        intent: 'save',
        folderId: 'folder-7',
        state: 'pending',
        operationId: 'op_seal'
      }
    })
  })

  it('refuses a write that drops or alters the seal, or takes the run back out of done', () => {
    const { store, reload } = fixture()
    const sealed = store.replaceSessionChainOutcomesAndFlush(chain(sealedSet(), 'done'), 0)
    const { completion, disposition: _disposition, ...unsealed } = sealed.outcomeSet!
    expect(() =>
      store.replaceSessionChainOutcomesAndFlush({ ...sealed, outcomeSet: unsealed }, 1)
    ).toThrow('sealed as completed')
    expect(() =>
      store.replaceSessionChainOutcomesAndFlush(
        {
          ...sealed,
          outcomeSet: { ...sealed.outcomeSet!, completion: { ...completion!, at: 999 } }
        },
        1
      )
    ).toThrow('sealed as completed')
    expect(() =>
      store.replaceSessionChainOutcomesAndFlush({ ...sealed, state: 'waiting' }, 1)
    ).toThrow('sealed as completed')
    expect(store.listSessionChains()).toEqual([sealed])
    expect(reload().chains[0]).toEqual(sealed)
  })

  it('still accepts what a seal allows: the disposition moving on, and a card filing', () => {
    const { store } = fixture()
    const sealed = store.replaceSessionChainOutcomesAndFlush(chain(sealedSet(), 'done'), 0)
    const applied = recordSessionRunDisposition(
      sealed.outcomeSet!,
      { operationId: 'op_seal', ok: true },
      200
    )
    const filed = store.replaceSessionChainOutcomesAndFlush(
      {
        ...sealed,
        outcomeSet: {
          ...applied,
          outcomes: applied.outcomes.map((outcome) => ({
            ...outcome,
            taskRef: { taskId: 'btk_card1234', attachedAt: 150 }
          }))
        }
      },
      1
    )
    expect(filed.state).toBe('done')
    expect(filed.outcomeSet!.completion).toEqual(sealed.outcomeSet!.completion)
    expect(filed.outcomeSet!.disposition).toMatchObject({ state: 'applied', appliedAt: 200 })
    expect(filed.outcomeSet!.outcomes[0]!.taskRef).toMatchObject({ taskId: 'btk_card1234' })
  })

  it('lets a sealed record that was persisted under another state be repaired to done', () => {
    const { store } = fixture()
    const contradictory = store.replaceSessionChainOutcomesAndFlush(
      chain(sealedSet(), 'waiting'),
      0
    )
    expect(contradictory.state).toBe('waiting')
    const repaired = store.replaceSessionChainOutcomesAndFlush(
      { ...contradictory, state: 'done' },
      1
    )
    expect(repaired.state).toBe('done')
    expect(repaired.outcomeSet!.completion).toEqual(contradictory.outcomeSet!.completion)
  })
})
