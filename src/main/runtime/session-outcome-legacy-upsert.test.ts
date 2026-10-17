import { expect, it } from 'vitest'
import { SessionChainPersistence } from '../persistence/loading-store/session-chain-persistence'
import { WriteSchedulingOperations } from '../persistence/loading-store/write-scheduling'
import type { PersistedState } from '../../shared/persisted-state-types'

it('refuses a new legacy group g1 chain but saves progress for the same plan already on disk', () => {
  const state = { sessionChains: [] } as unknown as PersistedState
  const scheduling = new WriteSchedulingOperations({ quitFlushStarted: true } as never, {} as never)
  const persistence = new SessionChainPersistence({ state }, scheduling)
  const input = {
    id: 'legacy',
    sourcePaneKey: 'pane',
    sourceRowKey: 'row',
    worktreeId: 'folder:work',
    workspacePath: '/work',
    hostId: 'local',
    auto: false,
    state: 'waiting',
    currentIndex: 0,
    createdAt: 1,
    updatedAt: 1,
    steps: ['one', 'two'].map((id) => ({
      id,
      group: 'g1',
      agent: 'codex',
      prompt: 'Review.',
      status: 'queued'
    }))
  }
  expect(() => persistence.upsertSessionChain(input)).toThrow(
    'legacy_renderer_chain_creation_refused'
  )
  expect(persistence.listSessionChains()).toEqual([])
  state.sessionChains = [input] as PersistedState['sessionChains']
  expect(() =>
    persistence.upsertSessionChain({
      ...input,
      steps: input.steps.map((step) => ({ ...step, prompt: 'Injected work' }))
    })
  ).toThrow('legacy_renderer_chain_creation_refused')
  const chain = persistence.upsertSessionChain({ ...input, state: 'done', currentIndex: 2 })

  expect(chain.outcomeSet).toBeUndefined()
  expect(persistence.listSessionChains()[0]!.steps.map((step) => step.group)).toEqual(['g1', 'g1'])
})
