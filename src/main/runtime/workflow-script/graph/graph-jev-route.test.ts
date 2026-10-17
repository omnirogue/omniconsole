import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createGraphJevRouter, graphRouteDecisionRequest } from './graph-jev-route'
import { GraphJevStore } from './graph-jev-store'
import { ONE_ANSWER_QUESTION } from '../../../../shared/workflow-one-answer'
import type { GraphCall } from './graph-plan-types'

let dir = ''
afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const call = { id: 'direct/route', route: { question: 'What is 17 × 23?' } } as GraphCall
const store = () => {
  dir = mkdtempSync(join(tmpdir(), 'graph-route-'))
  return GraphJevStore.forExecution('exec', dir)
}

describe('the JEV router', () => {
  it('asks one NOUL question about the question', () => {
    const request = graphRouteDecisionRequest(call.route!)
    expect(request.capability).toBe('workflow.route')
    expect(request.state).toEqual({ question: 'What is 17 × 23?' })
    expect(request.questions).toEqual({ yes: { type: 'noul', instructions: ONE_ANSWER_QUESTION } })
  })

  it('reads once and replays the reading, and never asks during recovery', async () => {
    const kept = store()
    let asked = 0
    const router = createGraphJevRouter({
      store: kept,
      decide: async () => {
        asked++
        return { answers: { yes: { type: 'noul', noul: 0.91 } } } as never
      }
    })
    const first = await router(call)
    expect(first).toMatchObject({ value: { noul: 0.91 } })
    expect(await router(call)).toEqual(first)
    expect(asked).toBe(1)
    const replay = createGraphJevRouter({ store: kept, cacheOnly: true })
    expect(await replay(call)).toEqual(first)
    await expect(replay({ ...call, id: 'other/route' })).rejects.toThrow('not recorded')
    // Another question never reuses this reading.
    await expect(replay({ ...call, route: { question: 'Other' } })).rejects.toThrow('not recorded')
  })

  it('never routes on part of a question: a long one goes to the full workflow unasked', async () => {
    const kept = store()
    let asked = 0
    const router = createGraphJevRouter({
      store: kept,
      decide: async () => {
        asked++
        return { answers: { yes: { type: 'noul', noul: 0.99 } } } as never
      }
    })
    const long = { ...call, route: { question: `${'é'.repeat(4_000)}?` } }
    const outcome = await router(long)
    expect(asked).toBe(0)
    expect(outcome).toMatchObject({
      value: { error: 'the question is longer than the 8,000 bytes JEV reads whole' }
    })
    expect((outcome as { value: { markdown: string } }).value.markdown).toContain(
      'so the full workflow ran'
    )
  })

  it.each([
    ['JEV is unavailable', { failed: 'no TypeSafe API key (TYPESAFE_API_KEY)' }, 'no TypeSafe'],
    ['JEV answers something else', { answers: {} }, 'did not answer']
  ])(
    'keeps the reason when %s, so a replay runs the full workflow again',
    async (_n, result, why) => {
      const kept = store()
      const router = createGraphJevRouter({ store: kept, decide: async () => result as never })
      const outcome = await router(call)
      expect(outcome).toMatchObject({ value: { error: expect.stringContaining(why) } })
      expect((outcome as { value: { markdown: string } }).value.markdown).toContain(
        'so the full workflow ran'
      )
      expect(kept.read(call.id)?.detail).toContain(why)
    }
  )
})
