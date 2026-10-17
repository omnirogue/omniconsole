import { expect, it } from 'vitest'
import type { SessionChain } from './session-chain-types'
import {
  sessionOutcomeChainForHost,
  sessionOutcomeChainForClient,
  sessionOutcomeTranscriptForHost,
  requireSessionOutcomeHost
} from './session-outcome-routing'

it('maps transcript ownership only to the matching capture host', () => {
  const source = {
    kind: 'provider' as const,
    hostId: 'runtime:peer' as const,
    runtimeEnvironmentId: 'peer',
    agent: 'codex',
    sessionId: 'conversation'
  }
  expect(
    sessionOutcomeTranscriptForHost(source, { kind: 'environment', environmentId: 'peer' })
  ).toEqual({ kind: 'provider', hostId: 'local', agent: 'codex', sessionId: 'conversation' })
  expect(() => sessionOutcomeTranscriptForHost(source, { kind: 'local' })).toThrow('does not own')
  expect(() =>
    sessionOutcomeTranscriptForHost(source, { kind: 'environment', environmentId: 'other' })
  ).toThrow('does not own')
  expect(() =>
    sessionOutcomeTranscriptForHost({ ...source, hostId: 'ssh:relay' }, { kind: 'local' })
  ).toThrow('does not own')
})

it('only converts the selected paired runtime alias and never forwards another host locally', () => {
  const chain = {
    hostId: 'runtime:tunnel',
    placement: 'runtime:tunnel',
    workspacePath: '/remote/folder',
    worktreeId: 'folder:remote',
    id: 'chain',
    sourcePaneKey: 'source',
    sourceRowKey: JSON.stringify(['runtime:tunnel', 'folder:remote', 'source']),
    auto: true,
    steps: [],
    currentIndex: 0,
    state: 'waiting',
    createdAt: 1,
    updatedAt: 1
  } as SessionChain
  const target = { kind: 'environment' as const, environmentId: 'tunnel' }
  const host = sessionOutcomeChainForHost(chain, target)
  expect(host).toMatchObject({
    hostId: 'local',
    placement: 'local',
    workspacePath: '/remote/folder',
    worktreeId: 'folder:remote'
  })
  expect(sessionOutcomeChainForClient(host, target)).toEqual(chain)
  expect(() => sessionOutcomeChainForHost(chain, { kind: 'local' })).toThrow('does not own')
  expect(() =>
    sessionOutcomeChainForHost(chain, { kind: 'environment', environmentId: 'other' })
  ).toThrow('does not own')
  expect(() => sessionOutcomeChainForHost({ ...chain, placement: 'ssh:relay' }, target)).toThrow(
    'Relay-only'
  )
})
it('requires explicit new peer ownership capability while preserving older local capability callers', () => {
  expect(
    requireSessionOutcomeHost({ version: 1, durableContinuation: true }, { kind: 'local' })
  ).toBeUndefined()
  expect(() =>
    requireSessionOutcomeHost(
      { version: 1, durableContinuation: true },
      { kind: 'environment', environmentId: 'peer' }
    )
  ).toThrow('no local fallback')
})
