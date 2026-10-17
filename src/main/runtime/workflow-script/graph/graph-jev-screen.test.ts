import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createGraphJevScreener } from './graph-jev-screen'
import { GraphJevStore } from './graph-jev-store'
import type { GraphCall } from './graph-plan-types'

let dir = ''
afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const call = {
  id: 'judge/screen',
  screen: { task: 'Name a bakery', rubric: '', candidates: [{ id: 'a', text: 'Crumb' }] }
} as GraphCall

describe('the JEV screener', () => {
  it('screens once and replays the result, and never screens during recovery', async () => {
    dir = mkdtempSync(join(tmpdir(), 'graph-screen-'))
    const store = GraphJevStore.forExecution('exec', dir)
    let asked = 0
    const screener = createGraphJevScreener({
      store,
      screen: async () => {
        asked++
        return {
          model: 'jev-1.13.0',
          scores: { a: 3 },
          criteria: [],
          unscored: [],
          retryableUnscored: [],
          calls: 1
        }
      }
    })
    const first = await screener(call)
    expect(first).toMatchObject({ value: { scores: { a: 3 }, unscored: [] } })
    expect(await screener(call)).toEqual(first)
    expect(asked).toBe(1)
    const replay = createGraphJevScreener({ store, cacheOnly: true })
    expect(await replay(call)).toEqual(first)
    await expect(replay({ ...call, id: 'other/screen' })).rejects.toThrow('not recorded')
  })

  it("keeps a failure with JEV's reason, so a replay ends the same way", async () => {
    dir = mkdtempSync(join(tmpdir(), 'graph-screen-'))
    const store = GraphJevStore.forExecution('exec', dir)
    const screener = createGraphJevScreener({
      store,
      screen: async () => ({ failed: 'no TypeSafe API key (TYPESAFE_API_KEY)' })
    })
    const outcome = await screener(call)
    expect(outcome).toMatchObject({ value: { error: 'no TypeSafe API key (TYPESAFE_API_KEY)' } })
    expect(store.read(call.id)?.detail).toBe('no TypeSafe API key (TYPESAFE_API_KEY)')
  })

  it('never persists a transient failure, so Retry with a healthy scorer re-scores the page', async () => {
    dir = mkdtempSync(join(tmpdir(), 'graph-screen-'))
    const store = GraphJevStore.forExecution('exec', dir)
    const failing = createGraphJevScreener({
      store,
      screen: async () => ({ failed: 'JEV answered rate_limited', retryable: true })
    })
    const failedOutcome = await failing(call)
    expect(failedOutcome).toMatchObject({ value: { error: 'JEV answered rate_limited' } })
    expect(store.read(call.id)).toBeUndefined()
    const healthy = createGraphJevScreener({
      store,
      screen: async () => ({
        model: 'jev-1.13.0',
        scores: { a: 3 },
        criteria: [],
        unscored: [],
        retryableUnscored: [],
        calls: 1
      })
    })
    const retried = await healthy(call)
    expect(retried).toMatchObject({ value: { scores: { a: 3 } } })
    expect(store.read(call.id)?.outcome).toEqual(retried)
  })

  it('still persists a non-retryable failure, so a replay ends the same way', async () => {
    dir = mkdtempSync(join(tmpdir(), 'graph-screen-'))
    const store = GraphJevStore.forExecution('exec', dir)
    const screener = createGraphJevScreener({
      store,
      screen: async () => ({ failed: 'no TypeSafe API key (TYPESAFE_API_KEY)', retryable: false })
    })
    await screener(call)
    expect(store.read(call.id)?.detail).toBe('no TypeSafe API key (TYPESAFE_API_KEY)')
  })

  it('never persists a mixed page (one transient miss among the failures): Retry re-scores it whole', async () => {
    dir = mkdtempSync(join(tmpdir(), 'graph-screen-'))
    const store = GraphJevStore.forExecution('exec', dir)
    // jevScreen itself voids a mixed page (one transient + one non-transient miss) as a single
    // retryable failure — this is what the screener actually receives, never a partial success.
    const failing = createGraphJevScreener({
      store,
      screen: async () => ({
        failed: 'JEV could not score 1 of 2 options (rate_limited)',
        retryable: true
      })
    })
    const failedOutcome = await failing({
      id: 'judge/screen',
      screen: {
        task: 'x',
        rubric: '',
        candidates: [
          { id: 'a', text: 'A' },
          { id: 'b', text: 'B' }
        ]
      }
    } as GraphCall)
    expect(failedOutcome).toMatchObject({
      value: { error: 'JEV could not score 1 of 2 options (rate_limited)' }
    })
    expect(store.read('judge/screen')).toBeUndefined()
    let asked = 0
    const healthy = createGraphJevScreener({
      store,
      screen: async (request) => {
        asked++
        return {
          model: 'jev-1.13.0',
          scores: Object.fromEntries(request.candidates.map((c) => [c.id, 3])),
          criteria: [],
          unscored: [],
          retryableUnscored: [],
          calls: 2
        }
      }
    })
    const retried = await healthy({
      id: 'judge/screen',
      screen: {
        task: 'x',
        rubric: '',
        candidates: [
          { id: 'a', text: 'A' },
          { id: 'b', text: 'B' }
        ]
      }
    } as GraphCall)
    // Retry asks about the whole page (both candidates), not just the one that was transient.
    expect(asked).toBe(1)
    expect(retried).toMatchObject({ value: { scores: { a: 3, b: 3 }, unscored: [] } })
  })

  it('records JEV certainty for calibration', async () => {
    dir = mkdtempSync(join(tmpdir(), 'graph-screen-'))
    const store = GraphJevStore.forExecution('exec', dir)
    const certainty = { a: { confidence: 0.7, levels: [0, 0, 0.3, 0.7, 0] } }
    const screener = createGraphJevScreener({
      store,
      screen: async () => ({
        model: 'jev-1.13.0',
        scores: { a: 2.7 },
        certainty,
        criteria: [],
        unscored: [],
        retryableUnscored: [],
        usage: { inputTokens: 40, outputTokens: 2 },
        calls: 1
      })
    })
    expect(await screener(call)).toMatchObject({
      value: { scores: { a: 2.7 }, certainty, usage: { inputTokens: 40, outputTokens: 2 } }
    })
  })
})
