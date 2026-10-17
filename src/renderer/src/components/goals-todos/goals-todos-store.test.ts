import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GoalsTodosDetails } from './goals-todos-rows'
import {
  cachedGoalsTodosDetails,
  GOALS_TODOS_MAX_CONCURRENT_READS,
  registerGoalsTodosConsumer,
  resetGoalsTodosStoreForTests
} from './goals-todos-store'

const reads = vi.hoisted(() => ({
  calls: [] as string[],
  resolvers: [] as ((details: GoalsTodosDetails) => void)[]
}))

vi.mock('./goals-todos-reader', () => ({
  readGoalsTodosDetails: (ref: { sessionId: string }) => {
    reads.calls.push(ref.sessionId)
    return new Promise<GoalsTodosDetails>((resolve) => reads.resolvers.push(resolve))
  }
}))

const DETAILS: GoalsTodosDetails = {
  goal: null,
  todos: [{ text: 'Step', status: 'pending' }],
  source: 'tool',
  lastMessageAt: null
}

function request(key: string, revision = 'r1') {
  return { key, revision, ref: { agent: 'claude', sessionId: key } }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve()
  }
}

beforeEach(() => {
  reads.calls = []
  reads.resolvers = []
})

afterEach(() => resetGoalsTodosStoreForTests())

describe('shared goals and to-dos reads', () => {
  it('reads a session wanted by several surfaces once', async () => {
    const view = registerGoalsTodosConsumer()
    const rows = registerGoalsTodosConsumer()
    const panel = registerGoalsTodosConsumer()
    view.update([request('a')])
    rows.update([request('a')])
    panel.update([request('a')])
    expect(reads.calls).toEqual(['a'])
    reads.resolvers[0]?.(DETAILS)
    await settle()
    expect(cachedGoalsTodosDetails('a')).toBe(DETAILS)
    rows.update([request('a')])
    expect(reads.calls).toEqual(['a'])
  })

  it('runs at most two reads at a time across every surface', async () => {
    const view = registerGoalsTodosConsumer()
    const rows = registerGoalsTodosConsumer()
    view.update([request('a'), request('b')])
    rows.update([request('c'), request('d')])
    expect(reads.calls).toHaveLength(GOALS_TODOS_MAX_CONCURRENT_READS)
    reads.resolvers[0]?.(DETAILS)
    await settle()
    expect(reads.calls).toHaveLength(3)
  })

  it('drops queued reads no surface wants any more', async () => {
    const rows = registerGoalsTodosConsumer()
    rows.update([request('a'), request('b'), request('c')])
    rows.dispose()
    reads.resolvers[0]?.(DETAILS)
    reads.resolvers[1]?.(DETAILS)
    await settle()
    expect(reads.calls).toEqual(['a', 'b'])
  })
})
