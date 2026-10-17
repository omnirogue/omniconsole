import { describe, expect, it } from 'vitest'
import { createBriefRecord } from '../../../../../shared/assisted-brief-revisions'
import { planBriefStart, settleBriefStart } from '../../../../../shared/assisted-brief-start'
import type { AssistedBriefRecord } from '../../../../../shared/assisted-brief-types'
import {
  ASSISTED_BRIEF_STORAGE_MAX_CHARS,
  discardSavedBrief,
  parseSavedBriefText,
  readSavedBrief,
  readSavedBriefText,
  savedBriefLaunchState,
  writeSavedBrief
} from './assisted-brief-memory'

function memoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, String(value))
  }
}

const SCOPE = '["profile-1","signed-in","user-1"]'
const OTHER_SCOPE = '["profile-2","signed-in","user-2"]'
const WORKTREE = 'repo-1::/work/app'

function brief(): AssistedBriefRecord {
  return createBriefRecord({
    briefId: 'brief-1',
    workspaceKey: 'workspace-1',
    original: { text: 'Draft a welcome email for new customers.', attachments: [] },
    drafter: { agent: 'codex', model: 'gpt-6-astra', effort: 'xhigh', label: 'Codex Team · Astra' },
    content: {
      outcome: { id: 'o1', text: 'A welcome email for new customers', origin: 'request' },
      sections: {
        scope: [],
        constraints: [],
        assumptions: [],
        deliverables: [],
        successChecks: []
      },
      questions: []
    },
    now: 1_000
  })
}

describe('assisted brief persistence', () => {
  it('survives a restart, including a start that was saved before launching', () => {
    const storage = memoryStorage()
    const plan = planBriefStart(brief(), {
      workspaceKey: 'workspace-1',
      favoriteId: 'codex-team-astra',
      verifiable: true,
      now: 2_000,
      probe: () => 'absent'
    })
    if (plan.kind !== 'launch') {
      throw new Error(plan.kind)
    }
    writeSavedBrief(storage, SCOPE, WORKTREE, plan.record)
    const restored = readSavedBrief(storage, SCOPE, WORKTREE)
    expect(restored.unreadable).toBe(false)
    expect(restored.record?.starts[0]).toMatchObject({
      status: 'starting',
      operationId: plan.start.operationId
    })
    expect(restored.record?.approval).toMatchObject({ revision: 1, workspaceKey: 'workspace-1' })
  })

  it('keeps each account and workspace separate', () => {
    const storage = memoryStorage()
    writeSavedBrief(storage, SCOPE, WORKTREE, brief())
    expect(readSavedBrief(storage, OTHER_SCOPE, WORKTREE)).toEqual({
      record: null,
      unreadable: false
    })
    expect(readSavedBrief(storage, SCOPE, 'repo-1::/work/other')).toEqual({
      record: null,
      unreadable: false
    })
  })

  it('reports tampered, malformed or oversized data as unreadable instead of trusting it', () => {
    const storage = memoryStorage()
    writeSavedBrief(storage, SCOPE, WORKTREE, brief())
    const key = storage.key(0)!
    const saved = JSON.parse(storage.getItem(key)!)
    saved.revisions[0].content.outcome.text = 'Something else entirely'
    storage.setItem(key, JSON.stringify(saved))
    expect(readSavedBrief(storage, SCOPE, WORKTREE)).toEqual({ record: null, unreadable: true })
    storage.setItem(key, '{not json')
    expect(readSavedBrief(storage, SCOPE, WORKTREE).unreadable).toBe(true)
    storage.setItem(key, JSON.stringify({ ...saved, starts: 'many' }))
    expect(readSavedBrief(storage, SCOPE, WORKTREE).unreadable).toBe(true)
    storage.setItem(key, 'x'.repeat(ASSISTED_BRIEF_STORAGE_MAX_CHARS + 1))
    expect(readSavedBrief(storage, SCOPE, WORKTREE).unreadable).toBe(true)
  })

  it('refuses to save an invalid brief and leaves the saved one in place', () => {
    const storage = memoryStorage()
    writeSavedBrief(storage, SCOPE, WORKTREE, brief())
    const invalid = { ...brief(), challengeCycles: 5 }
    expect(() => writeSavedBrief(storage, SCOPE, WORKTREE, invalid)).toThrow()
    expect(readSavedBrief(storage, SCOPE, WORKTREE).record?.challengeCycles).toBe(0)
  })

  it('discards only the brief the person chose, or data that cannot be read', () => {
    const storage = memoryStorage()
    writeSavedBrief(storage, SCOPE, WORKTREE, brief())
    discardSavedBrief(storage, SCOPE, WORKTREE, 'another-brief')
    expect(readSavedBrief(storage, SCOPE, WORKTREE).record?.briefId).toBe('brief-1')
    discardSavedBrief(storage, SCOPE, WORKTREE, 'brief-1')
    expect(readSavedBrief(storage, SCOPE, WORKTREE).record).toBeNull()
    storage.setItem(`assisted-brief-v1:${SCOPE}:${WORKTREE}`, '{broken')
    discardSavedBrief(storage, SCOPE, WORKTREE, null)
    expect(readSavedBrief(storage, SCOPE, WORKTREE)).toEqual({ record: null, unreadable: false })
  })

  it('offers a new brief beside one that already started, not just the started one', () => {
    const storage = memoryStorage()
    const launchState = () =>
      savedBriefLaunchState(parseSavedBriefText(readSavedBriefText(storage, SCOPE, WORKTREE)))
    expect(launchState()).toBe('none')
    writeSavedBrief(storage, SCOPE, WORKTREE, brief())
    expect(launchState()).toBe('saved')
    const plan = planBriefStart(brief(), {
      workspaceKey: 'workspace-1',
      favoriteId: 'codex-team-astra',
      verifiable: true,
      now: 2_000,
      probe: () => 'absent'
    })
    if (plan.kind !== 'launch') {
      throw new Error(plan.kind)
    }
    writeSavedBrief(storage, SCOPE, WORKTREE, plan.record)
    expect(launchState()).toBe('saved')
    const { operationId, tabId } = plan.start
    const started = settleBriefStart(plan.record, operationId, { ok: true, tabId }, 2_001)
    writeSavedBrief(storage, SCOPE, WORKTREE, started)
    expect(launchState()).toBe('started')
    storage.setItem(storage.key(0)!, '{broken')
    expect(launchState()).toBe('saved')
    expect(parseSavedBriefText(undefined)).toEqual({ record: null, unreadable: true })
  })
})
