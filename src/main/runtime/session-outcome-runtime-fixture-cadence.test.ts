import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionChainAgentStep } from '../../shared/session-chain-types'
import { outcomeRuntimeFixture } from './session-outcome-runtime-test-fixture'

type Fixture = ReturnType<typeof outcomeRuntimeFixture>
let fixture: Fixture | null = null
afterEach(async () => {
  await fixture?.dispose()
  fixture = null
})

const step = (id: string): SessionChainAgentStep =>
  ({ id, outcomeId: 'ship', agent: 'codex', prompt: `STEP:${id}`, status: 'queued' }) as never

// CI's 2s cadence tick held the lane over file I/O and turned every explicit settle into a skip.
describe('the outcome runtime fixture under the host cadence', () => {
  it('advances the run on every explicit settle while a cadence tick holds the lane', async () => {
    const f = outcomeRuntimeFixture((spec, workspace) => {
      writeFileSync(join(workspace, 'out.txt'), spec)
      return { body: 'done' }
    })
    fixture = f
    const steps = ['one', 'two', 'three'].map(step)
    await f.service.commit(
      {
        id: 'chain',
        workspacePath: f.workspace,
        worktreeId: 'folder:outcome',
        hostId: 'local',
        sourcePaneKey: 'source',
        sourceRowKey: 'row',
        auto: true,
        steps,
        currentIndex: 0,
        state: 'waiting',
        createdAt: 1,
        updatedAt: 1
      },
      {
        expectedRevision: 0,
        source: 'user',
        outcomes: [
          {
            id: 'ship',
            title: 'Three stages',
            finish: 'complete',
            dependsOn: [],
            stepIds: steps.map((entry) => entry.id),
            actions: [],
            conditions: [{ id: 'out', kind: 'file', target: join(f.workspace, 'out.txt') }]
          }
        ]
      }
    )
    await f.settle()
    await f.settleReports()
    // The interval's tick, fired with no report in flight so only its own file reads are pending.
    const cadence = f.service.tick()
    for (let index = 0; index < 12; index++) {
      await f.settle()
    }
    await cadence

    expect(f.launched.map((spec) => /STEP:(\w+)/.exec(spec)![1])).toEqual(['one', 'two', 'three'])
    expect(f.service.get('chain').outcomeSet!.completedSteps).toEqual(['one', 'two', 'three'])
  })
})
