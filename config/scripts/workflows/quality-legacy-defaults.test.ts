import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../../../src/main/runtime/orchestration/db'
import { WorkflowCheckpointStore } from '../../../src/main/runtime/workflow-script/workflow-checkpoint-store'
import { legacyQualityDefaults } from './quality-legacy-defaults'
import { STABLE_QUALITY_REVISIONS } from './quality-stable-snapshot'

const opened: OrchestrationDb[] = []
afterEach(() => {
  opened.splice(0).forEach((db) => db.close())
})

// Every revision a quality probe pins, with the call ceiling its checkpoint admits.
const PINNED = [
  ['council', STABLE_QUALITY_REVISIONS.council, 7],
  ['discover', STABLE_QUALITY_REVISIONS.discover, 30],
  ['discover', { discoverProgramRevision: 2 }, 28],
  ['discover', { discoverProgramRevision: 3 }, 28],
  ['discover', { discoverProgramRevision: 4 }, 30]
] as const

describe('legacy quality probe limits', () => {
  it.each(PINNED)('starts %s revision %j within its ceiling', (preset, revision, ceiling) => {
    const defaults = legacyQualityDefaults(preset, revision)
    expect(defaults).toMatchObject({
      callLimit: ceiling,
      attemptLimit: 3,
      maxHostAttempts: ceiling * 3,
      concurrency: 4
    })
    // Only the fields the legacy programs read; the current program's settings stay out.
    expect(Object.keys(defaults.discover).sort()).toEqual([
      'dimensions',
      'lenses',
      'maxCandidates',
      'minimumSeverity'
    ])
    const db = new OrchestrationDb(':memory:')
    opened.push(db)
    const start = {
      conversationId: 'quality',
      requestId: 'first',
      snapshot: { version: 1, ...revision },
      preset,
      fence: 1,
      attemptLimit: defaults.attemptLimit,
      callLimit: defaults.callLimit,
      budgetLimit: defaults.maxHostAttempts
    }
    // The probes pass these limits to service.start, which stores them through this checkpoint.
    expect(new WorkflowCheckpointStore(db.db).create(start)).toEqual(expect.any(String))
    expect(() =>
      new WorkflowCheckpointStore(db.db).create({
        ...start,
        requestId: 'current-defaults',
        callLimit: ceiling + 1
      })
    ).toThrow('Preset call ceiling exceeded')
  })
})
