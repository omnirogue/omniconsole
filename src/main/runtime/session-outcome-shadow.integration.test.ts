import { afterEach, expect, it, vi } from 'vitest'
import { outcomeRuntimeFixture } from './session-outcome-runtime-test-fixture'
import { installOrchestrationShadowObserver } from '../structured-decisions/orchestration-shadow'
import type { DecisionRequest } from '../../shared/structured-decisions'

const fixtures: ReturnType<typeof outcomeRuntimeFixture>[] = []
afterEach(async () => {
  installOrchestrationShadowObserver(null)
  for (const fixture of fixtures.splice(0)) {
    await fixture.dispose()
  }
})

it('a failed shadow observer cannot alter a real durable outcome save or host completion', async () => {
  const f = outcomeRuntimeFixture(() => ({ body: 'Recorded result' }))
  fixtures.push(f)
  const observer = vi.fn(async (_request: DecisionRequest) => {
    throw new Error('shadow unavailable')
  })
  installOrchestrationShadowObserver(observer)
  await f.service.commit(
    {
      id: 'shadow-chain',
      workspacePath: f.workspace,
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
    },
    {
      expectedRevision: 0,
      source: 'user',
      outcomes: [
        {
          id: 'result',
          title: 'Capture a result',
          finish: 'complete',
          dependsOn: [],
          conditions: [{ id: 'file', kind: 'file', target: 'result.txt' }],
          actions: [
            {
              id: 'capture',
              instruction: 'Write the result',
              agent: 'codex',
              conditionIds: ['file'],
              authority: 'existing-user-authority'
            }
          ]
        }
      ]
    }
  )
  f.service.dispose()
  f.write('result.txt', 'actual evidence')
  for (let index = 0; index < 5; index++) {
    await f.service.tick()
    await f.settle()
  }
  const saved = f.service.get('shadow-chain')
  expect(saved.state).toBe('done')
  expect(saved.outcomeSet!.completion).toBeDefined()
  expect(saved.outcomeSet!.outcomes[0]!.evidence[0]!.verifier).toBe('execution-host')
  expect(
    observer.mock.calls.some(([request]) => request.capability === 'orchestration.done_when')
  ).toBe(true)
  const sealed = structuredClone(saved)
  await f.service.tick()
  expect(f.service.get('shadow-chain')).toEqual(sealed)
})
