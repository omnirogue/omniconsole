import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { DecisionRequest } from '../../../../shared/structured-decisions'
import { createGraphJevVerifier } from './graph-jev-verify'
import { GraphJevStore } from './graph-jev-store'
import type { GraphCall } from './graph-plan-types'

let dir = ''
afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function workspace(): { root: string; store: GraphJevStore } {
  dir = mkdtempSync(join(tmpdir(), 'graph-verify-'))
  const root = join(dir, 'repo')
  mkdirSync(join(root, 'src'), { recursive: true })
  const lines = Array.from({ length: 200 }, (_, index) => `const line${index + 1} = ${index + 1}`)
  writeFileSync(join(root, 'src', 'store.ts'), lines.join('\n'))
  return { root, store: GraphJevStore.forExecution('exec', join(dir, 'records')) }
}

const call = (count: number) =>
  ({
    id: 'verify/jev-verify',
    verify: {
      scope: 'Goal: find defects in the store.',
      items: Array.from({ length: count }, (_, index) => ({
        key: `find.r1.${index + 1}`,
        title: `Lost write ${index + 1}`,
        location: 'src/store.ts:100',
        detail: 'The write is dropped when the queue is full.',
        ...(index === 0 ? { file: 'src/store.ts', line: 100 } : {})
      }))
    }
  }) as GraphCall

describe('the shadow JEV verifier', () => {
  it('asks one batched NOUL request with the cited code, and keeps each probability', async () => {
    const { root, store } = workspace()
    const asked: DecisionRequest[] = []
    const verifier = createGraphJevVerifier({
      store,
      workspace: async () => root,
      decide: async (request) => {
        asked.push(request)
        return {
          provider: 'typesafe',
          model: 'jev-1.13.0',
          usage: { inputTokens: 900, outputTokens: 30 },
          answers: Object.fromEntries(
            Object.keys(request.questions).map((id, index) => [
              id,
              { type: 'noul' as const, noul: index === 0 ? 0.95 : 0.4 }
            ])
          )
        }
      }
    })
    const outcome = await verifier(call(3))
    expect(asked).toHaveLength(1)
    const [request] = asked
    expect(Object.values(request!.questions).every((question) => question.type === 'noul')).toBe(
      true
    )
    const first = request!.questions.q0!.instructions as string
    expect(first).toContain('untrusted reviewer claim in state.findings.q0')
    expect(first).toContain('state.code.q0')
    expect(first).toContain('is this a real, in-scope defect')
    const state = request!.state as {
      scope: string
      code: Record<string, string>
      findings: Record<string, string>
    }
    expect(state.findings.q0).toMatch(
      /^A reviewer reports a defect at src\/store\.ts:100: Lost write 1\./
    )
    expect(state.scope).toBe('Goal: find defects in the store.')
    // An item without a cited line remains unverified and never reaches JEV.
    expect(state.code.q0).toContain('60 | const line60 = 60')
    expect(state.code.q0).toContain('140 | const line140 = 140')
    expect(state.code.q0).not.toContain('59 | ')
    expect(state.code.q1).toBeUndefined()
    expect(outcome).toMatchObject({
      value: {
        probabilities: { 'find.r1.1': 0.95 },
        unanswered: 2,
        model: 'jev-1.13.0',
        usage: { inputTokens: 900, outputTokens: 30 },
        calls: 1,
        withCode: 1
      }
    })
    expect((outcome as { value: { error?: string } }).value.error).toBeUndefined()
    // Kept: the replay reads it and never asks again.
    const replay = createGraphJevVerifier({ store, cacheOnly: true })
    expect(await replay(call(3))).toEqual(outcome)
    await expect(replay(call(2))).rejects.toThrow('not recorded')
    writeFileSync(join(root, 'src', 'store.ts'), 'changed')
    expect(await replay(call(3))).toEqual(outcome)
    const current = await verifier(call(3))
    expect(current).toMatchObject({ value: { probabilities: {} } })
  })

  it('splits more items than one request holds, never dropping one', async () => {
    const { root, store } = workspace()
    const sizes: number[] = []
    const verifier = createGraphJevVerifier({
      store,
      workspace: async () => root,
      decide: async (request) => {
        sizes.push(Object.keys(request.questions).length)
        return {
          provider: 'typesafe',
          model: 'jev-1.13.0',
          usage: { inputTokens: 1, outputTokens: 1 },
          answers: Object.fromEntries(
            Object.keys(request.questions).map((id) => [id, { type: 'noul' as const, noul: 0.5 }])
          )
        }
      }
    })
    const batch = call(70)
    for (const item of batch.verify!.items) {
      item.file = 'src/store.ts'
      item.line = 100
    }
    const outcome = (await verifier(batch)) as { value: { probabilities: object } }
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBe(70)
    expect(sizes.every((size) => size <= 60)).toBe(true)
    expect(Object.keys(outcome.value.probabilities)).toHaveLength(70)
  })

  it('records the kill switch as a gap with no probability, and never throws', async () => {
    const { root, store } = workspace()
    const verifier = createGraphJevVerifier({
      store,
      workspace: async () => root,
      environment: { JEV_DECISIONS_DISABLED: '1' }
    })
    const outcome = await verifier(call(2))
    expect(outcome).toMatchObject({
      value: { probabilities: {}, error: 'JEV is turned off on this computer' }
    })
    expect(store.read('verify/jev-verify')?.detail).toBe('JEV is turned off on this computer')
  })

  it('keeps unreadable code unverified without calling the provider', async () => {
    const { store } = workspace()
    let calls = 0
    const verifier = createGraphJevVerifier({
      store,
      workspace: async () => {
        throw new Error('This workflow has no workspace folder to read.')
      },
      decide: async () => {
        calls += 1
        throw new Error('socket hang up')
      }
    })
    const outcome = await verifier(call(1))
    expect(outcome).toMatchObject({
      value: { error: 'Required evidence was missing, changed or exceeded the limit' }
    })
    expect(calls).toBe(0)
  })
})
