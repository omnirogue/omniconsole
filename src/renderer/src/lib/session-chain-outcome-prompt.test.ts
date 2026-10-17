import { describe, expect, it } from 'vitest'
import type { SessionOutcomeSet } from '../../../shared/session-outcome-types'
import { buildSessionOutcomeContext } from './session-chain-outcome-prompt'

describe('buildSessionOutcomeContext', () => {
  it('retains every complete, blocked and unfinished outcome through handoffs', () => {
    const set = {
      schemaVersion: 1,
      revision: 2,
      outcomes: [
        {
          id: 'release_old',
          title: 'Release old app',
          finish: 'deploy',
          dependsOn: [],
          conditions: [{ id: 'deployed', kind: 'deployment', target: 'old-app' }],
          actions: [],
          revision: 1,
          status: 'satisfied',
          evidence: []
        },
        {
          id: 'build_ui',
          title: 'Build advanced UI',
          finish: 'complete',
          instructions: 'Do not release it.',
          dependsOn: [],
          conditions: [{ id: 'file', kind: 'file', target: 'ui-build.zip', version: 'abc' }],
          actions: [],
          revision: 2,
          status: 'running',
          evidence: []
        }
      ],
      removals: [],
      attempts: [],
      continuation: { owner: 'execution-host', hostId: 'local', epoch: 'epoch_1', state: 'owned' },
      updatedAt: 1
    } satisfies SessionOutcomeSet
    const context = buildSessionOutcomeContext(set)
    expect(context).toContain('[satisfied] Release old app')
    expect(context).toContain('[running] Build advanced UI')
    expect(context).toContain('Do not release it.')
  })
})
