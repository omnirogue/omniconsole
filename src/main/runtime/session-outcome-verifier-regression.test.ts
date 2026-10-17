import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { outcomeRuntimeFixture } from './session-outcome-runtime-test-fixture'
import { sessionOutcomeProgress } from '../../shared/session-outcome-state'
import { verifySessionOutcomeCondition } from './session-outcome-evidence'
import type { SessionOutcomeDefinition } from '../../shared/session-outcome-types'

const fixtures: ReturnType<typeof outcomeRuntimeFixture>[] = []
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.dispose()
  }
})
async function setup(
  conditions: SessionOutcomeDefinition['conditions'],
  review = false,
  extraOutcomes: SessionOutcomeDefinition[] = []
) {
  const f = outcomeRuntimeFixture(() => ({ body: 'No actions required' }))
  fixtures.push(f)
  await f.service.commit(
    {
      id: 'chain',
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
          title: 'Result',
          finish: review ? 'my-review' : 'complete',
          dependsOn: [],
          actions: [],
          conditions
        },
        ...extraOutcomes
      ]
    }
  )
  f.service.dispose()
  return f
}

/** An obligation nobody delivers, so the run is never sealed while the first outcome is watched. */
const undelivered: SessionOutcomeDefinition = {
  id: 'later',
  title: 'later',
  finish: 'complete',
  dependsOn: [],
  actions: [],
  conditions: [{ id: 'file', kind: 'file', target: './later.txt' }]
}

it('persists verifier exceptions with their specific reason instead of silent Waiting', async () => {
  const f = await setup(
    [
      { id: 'file', kind: 'file', target: './result.txt' },
      { id: 'review', kind: 'review', target: 'result' }
    ],
    true,
    [undelivered]
  )
  f.write('result.txt', 'v1')
  await f.service.tick()
  // A directory is not an immutable file candidate; this throws from review identity. The
  // outcome is satisfied by now (the owner's review goes to Done), so a person's own check is
  // what re-reads it.
  const { rmSync, mkdirSync } = await import('node:fs')
  rmSync(join(f.workspace, 'result.txt'))
  mkdirSync(join(f.workspace, 'result.txt'))
  await expect(f.service.verify('chain', 1, 'result', 'file')).rejects.toThrow('must name a file')
  const persisted = JSON.parse(readFileSync(join(f.workspace, '.omni/state.json'), 'utf8'))
  expect(persisted.sessionChains[0].outcomeSet.outcomes[0].blockedReason).toContain(
    'must name a file'
  )
  // The reason is a diagnostic the person can read; it is the run's reading that says what the
  // run is doing, and a verifier that threw is never success.
  const progress = sessionOutcomeProgress(f.service.get('chain').outcomeSet!)
  expect(progress.reasons.join('\n')).toContain('must name a file')
  expect(progress.lifecycle).not.toBe('complete')
})

it('retires completed commands and provider checks, and user checks invalidate changed approvals', async () => {
  const f = await setup(
    [
      { id: 'file', kind: 'file', target: './result.txt' },
      {
        id: 'command',
        kind: 'command',
        target: 'result validation',
        verification: {
          program: process.execPath,
          args: ['verify.cjs'],
          expectedStdout: 'validated'
        }
      },
      { id: 'review', kind: 'review', target: 'result' }
    ],
    true
  )
  f.write('result.txt', 'v1')
  f.write(
    'verify.cjs',
    "const fs=require('node:fs'); fs.appendFileSync('calls','x'); console.log('validated', Date.now(), Math.random())"
  )
  await f.service.tick()
  const version = f.service.get('chain').outcomeSet!.outcomes[0].conditions[2].version!
  await f.service.review('chain', 1, 'result', 'review', version)
  const calls = readFileSync(join(f.workspace, 'calls'), 'utf8')
  const scope = vi.spyOn(f.runtime, 'getSessionOutcomeExecutionScope')
  scope.mockClear()
  for (let i = 0; i < 20; i++) {
    await f.service.tick()
  }
  expect(scope).not.toHaveBeenCalled()
  expect(readFileSync(join(f.workspace, 'calls'), 'utf8')).toBe(calls)
  expect(sessionOutcomeProgress(f.service.get('chain').outcomeSet!).lifecycle).toBe('complete')
  await f.service.verify('chain', 1, 'result', 'command')
  expect(sessionOutcomeProgress(f.service.get('chain').outcomeSet!).lifecycle).toBe('complete')
  // The run is sealed by now: a file edited afterwards is about some later run, so a user check
  // changes nothing — the approval, the receipts and the success all stand.
  const sealed = f.service.get('chain')
  expect(sealed.outcomeSet!.completion).toBeDefined()
  f.write('result.txt', 'v2')
  await expect(f.service.verify('chain', 1, 'result', 'file')).resolves.toEqual(sealed)
  expect(readFileSync(join(f.workspace, 'calls'), 'utf8')).toBe(calls)
  expect(sessionOutcomeProgress(f.service.get('chain').outcomeSet!).lifecycle).toBe('complete')
  expect(f.launched).toEqual([])
})

it('a user check invalidates a changed approval while the run is still unfinished', async () => {
  const f = outcomeRuntimeFixture(() => ({ body: 'No actions required' }))
  fixtures.push(f)
  const outcome = (id: string, file: string, review: boolean): SessionOutcomeDefinition => ({
    id,
    title: id,
    finish: review ? 'my-review' : 'complete',
    dependsOn: [],
    actions: [],
    conditions: [
      { id: 'file', kind: 'file', target: `./${file}` },
      ...(review ? [{ id: 'review', kind: 'review' as const, target: id }] : [])
    ]
  })
  await f.service.commit(
    {
      id: 'chain',
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
      // The second outcome's file never appears, so the run is never complete and never sealed.
      outcomes: [outcome('result', 'result.txt', true), outcome('later', 'later.txt', false)]
    }
  )
  f.service.dispose()
  f.write('result.txt', 'v1')
  await f.service.tick()
  const version = f.service.get('chain').outcomeSet!.outcomes[0].conditions[1].version!
  await f.service.review('chain', 1, 'result', 'review', version)
  const approved = f.service.get('chain')
  expect(approved.outcomeSet!.outcomes[0].evidence.some((entry) => entry.kind === 'review')).toBe(
    true
  )
  expect(approved.outcomeSet!.completion).toBeUndefined()
  f.write('result.txt', 'v2')
  // The approval was of v1: it is invalidated. The owner's review asks nothing of them, so the
  // outcome is satisfied again at once — under v2's own receipt, never the old approval.
  await f.service.verify('chain', 1, 'result', 'file')
  const after = f.service.get('chain')
  expect(
    after.outcomeSet!.outcomes[0].evidence.some(
      (entry) => entry.receipt === `user-review:${version}`
    )
  ).toBe(false)
  expect(
    after.outcomeSet!.evidenceHistory?.some((entry) => entry.receipt === `user-review:${version}`)
  ).toBe(true)
  expect(after.outcomeSet!.outcomes[0].conditions[1].version).not.toBe(version)
  expect(after.outcomeSet!.completion).toBeUndefined()
  expect(sessionOutcomeProgress(after.outcomeSet!).lifecycle).not.toBe('complete')
  expect(f.launched).toEqual([])
})

it('rejects exit-zero and literal echo as publication evidence', async () => {
  const f = await setup([{ id: 'file', kind: 'file', target: './result' }])
  for (const verification of [
    { program: process.execPath, args: ['-e', 'process.exit(0)'] },
    { program: 'echo', args: ['published=build123'], expectedStdout: 'published=build123' }
  ]) {
    expect(
      await verifySessionOutcomeCondition(
        {
          id: 'publish',
          kind: 'deployment',
          target: 'test publication',
          version: 'build123',
          verification
        },
        f.workspace
      )
    ).toMatchObject({ verified: false })
  }
})

it('revalidates retained delivery evidence on an outcome edit without repeating completed actions', async () => {
  const f = await setup(
    [
      { id: 'file', kind: 'file', target: './result.txt' },
      { id: 'review', kind: 'review', target: 'result' }
    ],
    true
  )
  f.write('result.txt', 'v1')
  await f.service.tick()
  const old = f.service.get('chain')
  await f.service.review(
    'chain',
    1,
    'result',
    'review',
    old.outcomeSet!.outcomes[0].conditions[1].version!
  )
  f.write('result.txt', 'v2')
  const { sessionOutcomeDefinition } = await import('../../shared/session-outcome-types')
  const saved = f.service.get('chain')
  const revised = await f.service.commit(saved, {
    expectedRevision: 1,
    source: 'user',
    outcomes: [
      { ...sessionOutcomeDefinition(saved.outcomeSet!.outcomes[0]), title: 'Edited result' }
    ]
  })
  expect(revised.outcomeSet!.outcomes[0].evidence.some((entry) => entry.kind === 'review')).toBe(
    false
  )
  expect(sessionOutcomeProgress(revised.outcomeSet!).lifecycle).not.toBe('complete')
  expect(f.launched).toEqual([])
})
