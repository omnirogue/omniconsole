import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  NextStepDecisionRecord,
  NextStepSuggestionSet
} from '../../shared/next-step-suggestions'
import {
  NEXT_STEP_DECISION_LOG_ROTATE_BYTES,
  NEXT_STEP_DECISIONS_FILE,
  NEXT_STEP_INTERRUPTED_REASON,
  NEXT_STEP_MAX_SETS,
  NEXT_STEP_SET_MAX_AGE_MS,
  NEXT_STEP_SETS_FILE,
  NextStepSuggestionStore
} from './next-step-suggestion-store'

const NOW = 1_800_000_000_000
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'next-steps-store-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const conversation = { worktreeId: 'repo::/w', paneKey: 'tab:leaf', kind: 'pty' as const }

function set(over: Partial<NextStepSuggestionSet> = {}): NextStepSuggestionSet {
  return {
    id: 'set-1',
    conversation,
    worktreeId: 'repo::/w',
    turnKey: 'tab:leaf@1',
    origin: 'ai',
    createdAt: NOW,
    status: 'pending',
    suggestions: [
      { id: 's1', title: 'Run tests', prompt: 'Run the tests.', risk: 'safe', kind: 'verify' }
    ],
    model: 'sonnet',
    ...over
  }
}

const open = () => new NextStepSuggestionStore({ directory: dir, now: () => NOW })

describe('NextStepSuggestionStore', () => {
  it('survives a restart', async () => {
    const store = open()
    store.upsert(set())
    await store.flush()
    const reopened = open()
    reopened.load()
    expect(reopened.list()).toEqual([set()])
  })

  it('keeps JEV’s marks across a restart', async () => {
    const judged = set({
      rankedBy: 'jev',
      jevScores: { s1: 0.9, s2: 0.4 },
      suggestions: [
        {
          id: 's1',
          title: 'Deploy',
          prompt: 'Tidy up.',
          risk: 'risky',
          kind: 'other',
          riskReason: 'jev',
          jevRisk: 0.91
        },
        {
          id: 's2',
          title: 'Run tests',
          prompt: 'Run the tests.',
          risk: 'safe',
          kind: 'verify',
          jevRisk: 0.1
        }
      ]
    })
    const store = open()
    store.upsert(judged)
    await store.flush()
    const reopened = open()
    reopened.load()
    expect(reopened.list()).toEqual([judged])
  })

  it('keeps a step only JEV flagged risky across a restart', async () => {
    // Harmless words: the keyword floor alone reads this safe, so only the kept raise holds it.
    const flagged = set({
      suggestions: [
        {
          id: 's1',
          title: 'Tell the customers',
          prompt: 'Post the 2.4.0 notes.',
          risk: 'risky',
          kind: 'other',
          riskReason: 'jev',
          jevRisk: 0.93
        }
      ]
    })
    const store = open()
    store.upsert(flagged)
    await store.flush()
    const reopened = open()
    reopened.load()
    expect(reopened.list()[0]!.suggestions[0]).toMatchObject({ risk: 'risky', riskReason: 'jev' })
  })

  it('loads a set left generating by a dead process as failed ("interrupted") and rewrites it', async () => {
    writeFileSync(
      join(dir, NEXT_STEP_SETS_FILE),
      JSON.stringify({ sets: [set({ status: 'generating', suggestions: [] })] })
    )
    const store = open()
    store.load()
    expect(store.get('set-1')).toMatchObject({
      status: 'failed',
      error: NEXT_STEP_INTERRUPTED_REASON
    })
    await store.flush()
    const saved = JSON.parse(readFileSync(join(dir, NEXT_STEP_SETS_FILE), 'utf8'))
    expect(saved.sets[0].status).toBe('failed')
  })

  it('keeps at most 200 sets, none older than 7 days, and salvages unreadable rows', async () => {
    const store = open()
    store.upsert(set({ id: 'old', createdAt: NOW - NEXT_STEP_SET_MAX_AGE_MS - 1 }))
    for (let index = 0; index < NEXT_STEP_MAX_SETS + 5; index++) {
      store.upsert(set({ id: `s-${index}`, createdAt: NOW - 1_000 + index }))
    }
    expect(store.list()).toHaveLength(NEXT_STEP_MAX_SETS)
    expect(store.get('old')).toBeUndefined()
    expect(store.get('s-0')).toBeUndefined()
    expect(store.list()[0]!.id).toBe(`s-${NEXT_STEP_MAX_SETS + 4}`)
    await store.flush()

    writeFileSync(
      join(dir, NEXT_STEP_SETS_FILE),
      JSON.stringify({ sets: [set(), { id: 'broken' }, set({ id: 'b', origin: 'parsed' })] })
    )
    const reopened = open()
    reopened.load()
    expect(reopened.list().map((entry) => entry.id)).toEqual(expect.arrayContaining(['set-1', 'b']))
    expect(reopened.list()).toHaveLength(2)
  })

  it('starts empty on a missing or corrupt file', () => {
    const store = open()
    store.load()
    expect(store.list()).toEqual([])
    writeFileSync(join(dir, NEXT_STEP_SETS_FILE), '{not json')
    store.load()
    expect(store.list()).toEqual([])
  })

  it('appends decisions one per line and rotates past ~5 MB', async () => {
    const store = open()
    const record: NextStepDecisionRecord = {
      at: NOW,
      setId: 'set-1',
      origin: 'ai',
      offered: [{ id: 's1', title: 'Run tests', risk: 'safe', kind: 'verify' }],
      decision: { action: 'dismiss' }
    }
    await store.appendDecision(record)
    await store.appendDecision({ ...record, decision: { action: 'save', suggestionIds: ['s1'] } })
    const log = join(dir, NEXT_STEP_DECISIONS_FILE)
    const lines = readFileSync(log, 'utf8').trim().split('\n')
    expect(lines.map((line) => JSON.parse(line).decision.action)).toEqual(['dismiss', 'save'])

    writeFileSync(log, 'x'.repeat(NEXT_STEP_DECISION_LOG_ROTATE_BYTES))
    await store.appendDecision(record)
    expect(statSync(`${log}.1`).size).toBe(NEXT_STEP_DECISION_LOG_ROTATE_BYTES)
    expect(readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(1)
  })

  it('surfaces a failed save and a failed log append instead of swallowing them', async () => {
    const blocked = join(dir, 'not-a-dir')
    writeFileSync(blocked, 'x')
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = new NextStepSuggestionStore({ directory: blocked, now: () => NOW })
    store.upsert(set())
    await store.flush()
    expect(store.storageError).toMatch(/^Suggestions could not be saved: /)
    await expect(
      store.appendDecision({
        at: NOW,
        setId: 'set-1',
        origin: 'ai',
        offered: [],
        decision: { action: 'dismiss' }
      })
    ).rejects.toThrow()
    expect(errors.mock.calls.map((call) => String(call[0]))).toEqual([
      expect.stringContaining(`saving 1 suggestion sets to ${join(blocked, NEXT_STEP_SETS_FILE)}`),
      expect.stringContaining('appending the decision for set set-1')
    ])
    errors.mockRestore()
  })

  it('bumps its revision on every change', () => {
    const store = open()
    const before = store.revision
    store.upsert(set())
    store.update('set-1', (current) => ({ ...current, status: 'dismissed' }))
    store.remove('set-1')
    expect(store.revision).toBe(before + 3)
  })
})
